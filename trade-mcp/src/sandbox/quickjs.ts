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
  let timer: NodeJS.Timeout | undefined;

  const fail = (error: string): RunResult => ({
    ok: false,
    logs,
    error: Date.now() > deadline ? timeoutMsg : error,
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
    runtime.setInterruptHandler(() => Date.now() > deadline);
    vm = runtime.newContext();
    return await execute(vm, runtime);
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
          const arg = argHandle === undefined ? undefined : vm.dump(argHandle);
          Promise.resolve()
            .then(() => hostFn(arg))
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
            .finally(pump);
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
