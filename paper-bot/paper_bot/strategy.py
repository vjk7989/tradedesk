def sma(vals, n):
    return sum(vals[-n:]) / n


def closed_only(candles, now, period):
    """Drop the still-forming candle (open time + period > now); sort oldest first."""
    # Dedupe by open time, keeping the LAST occurrence (a later copy is the API's most recent
    # revision of that candle); otherwise duplicates would inflate the SLOW+1 count and skew the SMAs.
    uniq = {c["time"]: c for c in candles if c["time"] + period <= now}
    return [uniq[t] for t in sorted(uniq)]


def evaluate(closes, fast_n, slow_n):
    """Return (signal, fast, slow, reason). signal in up/down/none. Needs slow_n+1 closes."""
    if len(closes) < slow_n + 1:
        raise ValueError(f"need {slow_n + 1} closed candles, got {len(closes)}")
    f, s = sma(closes, fast_n), sma(closes, slow_n)
    pf, ps = sma(closes[:-1], fast_n), sma(closes[:-1], slow_n)
    if pf <= ps and f > s:
        return "up", f, s, f"fast {f:.2f} crossed above slow {s:.2f}"
    if pf >= ps and f < s:
        return "down", f, s, f"fast {f:.2f} crossed below slow {s:.2f}"
    rel = "above" if f > s else "below" if f < s else "equal to"
    pct = abs(f - s) / s * 100 if s else 0
    return "none", f, s, f"no cross (fast {rel} slow by {pct:.2f}%)"


def decide(cfg, closes, cur):
    """Dispatch on cfg.strategy. Returns (signal, f, s, reason); sma_cross is exactly evaluate()."""
    if cfg.strategy == "rsi_revert":
        from .strategy_rsi import evaluate_rsi
        return evaluate_rsi(closes, cfg.rsi_len, cfg.rsi_low, cfg.rsi_high, cur, cfg.allow_short)
    return evaluate(closes, cfg.fast, cfg.slow)
