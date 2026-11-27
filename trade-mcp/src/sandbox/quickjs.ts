import { parse } from "acorn";
import { newQuickJSWASMModule, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";

export type Bindings = Record<string, Record<string, (args: unknown) => Promise<unknown>>>;

export interface RunOpts {
  timeoutMs?: number;
  memoryBytes?: number;
  maxLogBytes?: number;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  error?: string;
  truncated?: boolean;
}

const TIMEOUT = Symbol("timeout");
const MIN_MEMORY = 1024 * 1024;
// runtime.setMemoryLimit does not count ArrayBuffer/TypedArray backing stores, so the WASM linear
// memory itself is also capped: memoryBytes + this headroom (absolute WASM size).
const WASM_HEADROOM = 16 * 1024 * 1024;
// Unawaited binding calls keep a host copy of their argument until they settle: bound them.
const MAX_ARG_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 64;
const MEMORY_ERROR = "memory limit exceeded";
// Binary-buffer surface that trading scripts never need (shared memory, raw views, wasm).
const REMOVED_GLOBALS = [
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];

export async function runCode(code: string, bindings: Bindings, opts: RunOpts = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const memoryBytes = opts.memoryBytes ?? 64 * 1024 * 1024;
  const maxLogBytes = opts.maxLogBytes ?? 64 * 1024;

  const logs: string[] = [];
  let logBytes = 0;
  let truncated = false;
  const deadline = Date.now() + timeoutMs;
  const timeoutMsg = `timeout: execution exceeded ${timeoutMs}ms`;
  let disposed = false;
  let memoryExceeded = false;
  let timer: NodeJS.Timeout | undefined;

  const fail = (error: string): RunResult => ({
    ok: false,
    logs,
    error: memoryExceeded ? MEMORY_ERROR : Date.now() > deadline ? timeoutMsg : error,
    ...(truncated ? { truncated } : {}),
  });
  const errMessage = (e: unknown): string => {
    if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
    return String(e);
  };

  if (memoryBytes < MIN_MEMORY) {
    return fail(`memory limit too small (min ${MIN_MEMORY} bytes)`);
  }
  try {
    parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (e) {
    return fail(`syntax error: ${errMessage(e)}`);
  }

  let runtime: QuickJSRuntime | undefined;
  let vm: QuickJSContext | undefined;
  try {
    const QuickJS = await newQuickJSWASMModule();
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(512 * 1024);
    vm = runtime.newContext();
    for (const g of REMOVED_GLOBALS) {
      vm.unwrapResult(vm.evalCode(`delete globalThis[${JSON.stringify(g)}]`)).dispose();
    }
    const wasmMemory = QuickJS.getWasmMemory();
    const wasmCeiling = memoryBytes + WASM_HEADROOM;
    runtime.setInterruptHandler(() => {
      if (wasmMemory.buffer.byteLength > wasmCeiling) memoryExceeded = true;
      return memoryExceeded || Date.now() > deadline;
    });
    const res = await execute(vm, runtime);
    // Short runs may finish between interrupt checks; linear memory never shrinks, so check the peak.
    if (wasmMemory.buffer.byteLength > wasmCeiling) memoryExceeded = true;
    return memoryExceeded ? fail(MEMORY_ERROR) : res;
  } catch (e) {
    return fail(errMessage(e));
  } finally {
    if (timer) clearTimeout(timer);
    disposed = true;
    disposeQuietly(vm, runtime);
  }

  async function execute(vm: QuickJSContext, runtime: QuickJSRuntime): Promise<RunResult> {
    const jsonParse = vm.unwrapResult(vm.evalCode("JSON.parse"));
    const fromJson = (json: string | undefined): QuickJSHandle => {
      if (json === undefined) return vm.undefined;
      const s = vm.newString(json);
      try {
        return vm.unwrapResult(vm.callFunction(jsonParse, vm.undefined, s));
      } finally {
        s.dispose();
      }
    };

    // console
    const consoleObj = vm.newObject();
    for (const level of ["log", "info", "warn", "error"]) {
      const fn = vm.newFunction(level, (...args: QuickJSHandle[]) => {
        const line = args
          .map((a) => {
            const v = vm.dump(a);
            return fmt(v);
          })
          .join(" ");
        if (!truncated) {
          const size = Buffer.byteLength(line);
          if (logBytes + size > maxLogBytes) truncated = true;
          else {
            logBytes += size;
            logs.push(line);
          }
        }
      });
      vm.setProp(consoleObj, level, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    let inFlight = 0;
    let pendingBytes = 0;
    // host bindings: each call returns a QuickJS promise settled from the host
    const pump = () => {
      if (!disposed) runtime.executePendingJobs();
    };
    for (const [ns, fns] of Object.entries(bindings)) {
      const nsObj = vm.newObject();
      for (const [name, hostFn] of Object.entries(fns)) {
        const fn = vm.newFunction(name, (argHandle?: QuickJSHandle) => {
          const deferred = vm.newPromise();
          const rejectWith = (msg: string) => {
            const err = vm.newError({ name: "Error", message: msg });
            deferred.reject(err);
            err.dispose();
          };
          let arg = argHandle === undefined ? undefined : vm.dump(argHandle);
          let argBytes = 0;
          try {
            argBytes = arg === undefined ? 0 : Buffer.byteLength(JSON.stringify(arg) ?? "");
          } catch {
            argBytes = Infinity;
          }
          if (argBytes > MAX_ARG_BYTES) {
            arg = undefined;
            rejectWith("binding argument too large");
            return deferred.handle;
          }
          if (inFlight >= MAX_IN_FLIGHT) {
            arg = undefined;
            rejectWith("too many pending binding calls");
            return deferred.handle;
          }
          if (pendingBytes + argBytes > memoryBytes) {
            arg = undefined;
            rejectWith("too many pending binding calls: pending argument bytes exceed the memory limit");
            return deferred.handle;
          }
          inFlight++;
          pendingBytes += argBytes;
          const callArg = arg;
          arg = undefined;
          Promise.resolve()
            .then(() => hostFn(callArg))
            .then(
              (value) => {
                if (disposed) return;
                let h: QuickJSHandle;
                try {
                  h = fromJson(value === undefined ? undefined : JSON.stringify(value));
                } catch (e) {
                  rejectWith(errMessage(e));
                  return;
                }
                deferred.resolve(h);
                if (h !== vm.undefined) h.dispose();
              },
              (e) => {
                if (!disposed) rejectWith(errMessage(e));
              },
            )
            .finally(() => {
              inFlight--;
              pendingBytes -= argBytes;
              pump();
            });
          return deferred.handle;
        });
        vm.setProp(nsObj, name, fn);
        fn.dispose();
      }
      vm.setProp(vm.global, ns, nsObj);
      nsObj.dispose();
    }

    // Code becomes the body of an async function (via the AsyncFunction constructor,
    // so the code string cannot break out of the wrapper).
    const src = `(async()=>JSON.stringify(await new (Object.getPrototypeOf(async function(){}).constructor)(${JSON.stringify(code)})()))()`;
    const evaluated = vm.evalCode(src);
    if (evaluated.error) {
      const e = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return fail(errMessage(e));
    }
    const hostPromise = vm.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    pump();

    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - Date.now()));
    });
    const outcome = await Promise.race([hostPromise, timeout]);
    if (outcome === TIMEOUT) return fail(timeoutMsg);
    if (outcome.error) {
      const e = vm.dump(outcome.error);
      outcome.error.dispose();
      return fail(errMessage(e));
    }
    const json = vm.dump(outcome.value) as string | undefined;
    outcome.value.dispose();
    return {
      ok: true,
      ...(json === undefined ? {} : { result: JSON.parse(json) }),
      logs,
      ...(truncated ? { truncated } : {}),
    };
  }
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    try {
      return String(v);
    } catch {
      return "[unserializable]";
    }
  }
}

function disposeQuietly(vm?: QuickJSContext, runtime?: QuickJSRuntime): void {
  try {
    vm?.dispose();
  } catch {
    /* ignore */
  }
  try {
    runtime?.dispose();
  } catch {
    /* ignore */
  }
}
