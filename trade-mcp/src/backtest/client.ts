export class BacktestError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "BacktestError";
  }
}

export interface BacktestRequest {
  code: string;
  symbols: string[];
  start: string;
  end: string;
  interval?: string;
  capital?: number;
  costs?: Record<string, unknown>;
  source?: string;
  signal_parameters?: Record<string, unknown>;
}

export interface BacktestResult {
  ok: boolean;
  metrics?: Record<string, unknown>;
  equity?: { date: string; value: number | null }[];
  trades?: Record<string, unknown>[];
  warnings?: string[];
  error?: string | null;
}

export interface WalkForwardRequest {
  code: string;
  symbols: string[];
  start: string;
  end: string;
  train_days: number;
  test_days: number;
  candidates: Record<string, unknown>[];
  metric?: "sharpe" | "total_return" | "calmar";
  interval?: string;
  capital?: number;
  costs?: Record<string, unknown>;
  source?: string;
}

export interface WalkForwardFold {
  train: string[];
  test: string[];
  chosen: Record<string, unknown>;
  train_score: number;
  test_metrics: Record<string, unknown>;
}

export interface WalkForwardResult {
  ok: boolean;
  metric?: string | null;
  folds?: WalkForwardFold[];
  oos_equity?: { date: string; value: number | null }[];
  summary?: Record<string, unknown>;
  warnings?: string[];
  error?: string | null;
}

export interface BacktestClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  walkForwardTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BacktestClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly walkForwardTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BacktestClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 180000;
    this.walkForwardTimeoutMs = opts.walkForwardTimeoutMs ?? 660000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private redact(s: string): string {
    return this.token ? s.split(this.token).join("[REDACTED]") : s;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const fail = (msg: string, status?: number) => new BacktestError(this.redact(msg), status);
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort();
        rej(fail(`backtest request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    timeout.catch(() => {});
    let res: Response;
    let text: string;
    try {
      const work = (async () => {
        const r = await this.fetchImpl(`${this.base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        return [r, await r.text()] as const;
      })();
      work.catch(() => {});
      [res, text] = await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof BacktestError) throw e;
      if (ctl.signal.aborted) throw fail(`backtest request timeout after ${timeoutMs}ms`);
      throw fail(`backtest service unreachable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    const s = res.status;
    if (s === 401) throw fail("backtest service rejected the token (401)", s);
    if (s === 503) throw fail("backtest service not configured (503)", s);
    if (s === 429) throw fail("backtest service busy, retry later", s);
    if (s === 413) throw fail("backtest request too large (413)", s);
    if (s === 422) throw fail(`backtest request invalid (422): ${this.redact(text).slice(0, 500)}`, s);
    if (s < 200 || s >= 300) throw fail(`backtest service error (${s})`, s);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fail("backtest service returned a non-JSON response", s);
    }
  }

  async run(req: BacktestRequest): Promise<BacktestResult> {
    return (await this.post("/backtest", req, this.timeoutMs)) as BacktestResult;
  }

  async walkForward(req: WalkForwardRequest): Promise<WalkForwardResult> {
    return (await this.post("/walkforward", req, this.walkForwardTimeoutMs)) as WalkForwardResult;
  }
}
