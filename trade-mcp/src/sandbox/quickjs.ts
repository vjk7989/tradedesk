import { parse } from "acorn";
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";

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
const ABORT = Symbol("abort");
const MIN_MEMORY = 1024 * 1024;
// runtime.setMemoryLimit does not count ArrayBuffer/TypedArray backing stores, so the WASM linear
// memory itself is also capped: memoryBytes + this headroom (absolute WASM size).
// 16 MB (the O-8 brief said 32 MB): measured to be enough for the runtime's own overhead plus string
// marshalling at the largest allowed binding payloads, and it is the tighter bound.
const WASM_HEADROOM = 16 * 1024 * 1024;
// Unawaited binding calls keep a host copy of their argument until they settle: bound them.
const MAX_ARG_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 64;
// Binding results are copied into the guest: cap them (also bounded by memoryBytes/4, see resultCap).
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
// Only parses of at least this many chars pay for the host check (small ones are cheap, and loops of them
// run enough bytecodes for the interrupt handler to see the ceiling).
const GUARD_MIN_CHARS = 16 * 1024;
// The module's initial linear memory (what it measures right after creating a context: 16 MB). Its
// hard maximum is the ceiling + this baseline, so any native call (repeat, join, replace, RegExp, sort,
// stringify, ...) that grows past it gets a failed malloc, i.e. an "out of memory" InternalError in the guest.
const WASM_PAGE = 64 * 1024;
const WASM_INITIAL_PAGES = 256;
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
    error:
      memoryExceeded || /out of memory/i.test(error) ? MEMORY_ERROR : Date.now() > deadline ? timeoutMsg : error,
    ...(truncated ? { truncated } : {}),
  });
  // Total: hostile errors (throwing message getters, toString, Symbol.toPrimitive, Proxies) never throw.
  const errMessage = (e: unknown): string => {
    try {
      if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
      return String(e);
    } catch {
      return "binding failed";
    }
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
  let jsonParse: QuickJSHandle | undefined;
  let guestSize: QuickJSHandle | undefined;
  let wasmMemory: { buffer: { byteLength: number } } | undefined;
  let wasmCeiling = Infinity;
  const resultCap = Math.min(MAX_RESULT_BYTES, Math.floor(memoryBytes / 4));
  const checkCeiling = () => {
    if (wasmMemory && wasmMemory.buffer.byteLength > wasmCeiling) memoryExceeded = true;
  };
  try {
    const maxPages = Math.ceil((memoryBytes + WASM_HEADROOM) / WASM_PAGE) + WASM_INITIAL_PAGES;
    const memory = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum: maxPages });
    const QuickJS = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(512 * 1024);
    vm = runtime.newContext();
    for (const g of REMOVED_GLOBALS) {
      vm.unwrapResult(vm.evalCode(`delete globalThis[${JSON.stringify(g)}]`)).dispose();
    }
    // Fail closed: a non-configurable property would survive the delete above.
    const survivors = vm.dump(
      vm.unwrapResult(
        vm.evalCode(`${JSON.stringify(REMOVED_GLOBALS)}.filter((g) => globalThis[g] !== undefined).join(",")`),
      ),
    );
    if (survivors !== "") return fail("sandbox init failed");
    wasmMemory = QuickJS.getWasmMemory();
    wasmCeiling = memoryBytes + WASM_HEADROOM;
    runtime.setInterruptHandler(() => {
      checkCeiling();
      return memoryExceeded || Date.now() > deadline;
    });
    const res = await execute(vm, runtime);
    // Short runs may finish between interrupt checks; linear memory never shrinks, so check the peak.
    checkCeiling();
    return memoryExceeded ? fail(MEMORY_ERROR) : res;
  } catch (e) {
    return fail(errMessage(e));
  } finally {
    if (timer) clearTimeout(timer);
    disposed = true;
    // Handles must go before the context, or context/runtime disposal asserts on leaked objects.
    for (const h of [jsonParse, guestSize]) {
      try {
        h?.dispose();
      } catch {
        /* ignore */
      }
    }
    disposeQuietly(vm, runtime);
  }

  async function execute(vm: QuickJSContext, runtime: QuickJSRuntime): Promise<RunResult> {
    jsonParse = vm.unwrapResult(vm.evalCode("JSON.parse"));
    const parseFn = jsonParse;
    // Single snapshot of a binding argument: JSON.stringify is captured here, before any user code can
    // replace it, and called exactly once per call inside the guest (under the guest memory limit), so
    // toJSON/getters/Proxies run once. Returns the guest string, undefined, or null when not serialisable.
    guestSize = vm.unwrapResult(
      vm.evalCode(`(() => { const S = JSON.stringify, IE = InternalError; return (a) => { try { return S(a); } catch (e) { if (e instanceof IE) throw e; return null; } }; })()`),
    );
    const snapFn = guestSize;
    // JSON.parse is one native call: it allocates many MB of transient host memory without running the
    // bytecodes that drive the interrupt handler (QuickJS polls it every ~10k back-edges/calls), so a loop
    // of large parses overshoots the WASM ceiling unseen. Wrap it with a host check after each call; once the
    // ceiling is exceeded it throws (sticky), and the interrupt handler ends the run at its next poll.
    const guard = vm.newFunction("guard", () => {
      checkCeiling();
      return memoryExceeded ? vm.true : vm.false;
    });
    try {
      const install = vm.unwrapResult(
        vm.evalCode(
          `(guard) => { const P = JSON.parse, Str = String; Object.defineProperty(JSON, "parse", { value: function parse(text, reviver) { const s = Str(text); const v = P(s, reviver); if (s.length > ${GUARD_MIN_CHARS} && guard()) throw new Error(${JSON.stringify(MEMORY_ERROR)}); return v; }, writable: true, configurable: true }); }`,
        ),
      );
      try {
        vm.unwrapResult(vm.callFunction(install, vm.undefined, guard)).dispose();
      } finally {
        install.dispose();
      }
    } finally {
      guard.dispose();
    }
    const fromJson = (json: string | undefined): QuickJSHandle => {
      if (json === undefined) return vm.undefined;
      const s = vm.newString(json);
      try {
        return vm.unwrapResult(vm.callFunction(parseFn, vm.undefined, s));
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

    // Resolves when a settling binding finds the heap ceiling exceeded: the run fails without resuming the guest.
    let abortRun: () => void = () => {};
    const aborted = new Promise<typeof ABORT>((resolve) => {
      abortRun = () => resolve(ABORT);
    });
    let inFlight = 0;
    let pendingBytes = 0;
    // host bindings: each call returns a QuickJS promise settled from the host
    const pump = () => {
      checkCeiling();
      if (!disposed) runtime.executePendingJobs();
    };
    for (const [ns, fns] of Object.entries(bindings)) {
      const nsObj = vm.newObject();
      for (const [name, hostFn] of Object.entries(fns)) {
        const fn = vm.newFunction(name, (argHandle?: QuickJSHandle) => {
          const deferred = vm.newPromise();
          const rejectWith = (msg: string) => {
            // Host error text is capped like results (it is copied into the guest too).
            if (msg.length > resultCap) msg = msg.slice(0, resultCap) + "...[truncated]";
            const err = vm.newError({ name: "Error", message: msg });
            deferred.reject(err);
            err.dispose();
          };
          // Defence in depth: whatever goes wrong while settling, the guest promise still settles.
          const settleFailed = () => {
            try {
              if (!disposed) rejectWith("binding failed");
            } catch {
              /* nothing left to do */
            }
          };
          let arg: unknown;
          let argBytes = 0;
          if (argHandle !== undefined) {
            let r: ReturnType<typeof vm.callFunction>;
            try {
              r = vm.callFunction(snapFn, vm.undefined, argHandle);
            } catch {
              rejectWith("binding argument too large");
              return deferred.handle;
            }
            if (r.error) {
              r.error.dispose(); // out of guest memory or interrupted while serialising
              rejectWith("binding argument too large");
              return deferred.handle;
            }
            const snap = r.value;
            try {
              const kind = vm.typeof(snap);
              if (kind === "string") {
                // .length is an intrinsic of the string primitive; the host copy is only made when small.
                const len = vm.getNumber(vm.getProp(snap, "length"));
                if (len > MAX_ARG_BYTES) {
                  rejectWith("binding argument too large");
                  return deferred.handle;
                }
                const json = vm.getString(snap);
                // Second check, on the host bytes of the very string the guest measured.
                argBytes = Buffer.byteLength(json);
                if (argBytes > MAX_ARG_BYTES) {
                  rejectWith("binding argument too large");
                  return deferred.handle;
                }
                arg = JSON.parse(json);
              } else if (kind !== "undefined") {
                rejectWith("binding argument not serialisable");
                return deferred.handle;
              }
            } finally {
              snap.dispose();
            }
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
                try {
                if (disposed) return;
                checkCeiling();
                if (memoryExceeded) return abortRun();
                let h: QuickJSHandle;
                try {
                  const json = value === undefined ? undefined : JSON.stringify(value);
                  if (json !== undefined && json.length > resultCap) {
                    rejectWith(
                      `binding result too large (${json.length} chars, max ${resultCap}): narrow the query, e.g. fewer bars or a shorter date range`,
                    );
                    return;
                  }
                  h = fromJson(json);
                } catch (e) {
                  rejectWith(errMessage(e));
                  return;
                }
                deferred.resolve(h);
                if (h !== vm.undefined) h.dispose();
                } catch {
                  settleFailed();
                }
              },
              (e) => {
                try {
                  checkCeiling();
                  if (memoryExceeded) return abortRun();
                  if (!disposed) rejectWith(errMessage(e));
                } catch {
                  settleFailed();
                }
              },
            )
            .finally(() => {
              inFlight--;
              pendingBytes -= argBytes;
              try {
                pump();
              } catch {
                /* never an unhandled rejection */
              }
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
    const outcome = await Promise.race([hostPromise, timeout, aborted]);
    if (outcome === ABORT) return fail(MEMORY_ERROR);
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
  } finally {
    try {
      runtime?.dispose();
    } catch {
      /* ignore */
    }
  }
}
