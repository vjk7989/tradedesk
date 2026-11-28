def sma(vals, n):
    return sum(vals[-n:]) / n


def closed_only(candles, now, period):
    """Drop the still-forming candle (open time + period > now); sort oldest first."""
    return sorted((c for c in candles if c["time"] + period <= now), key=lambda c: c["time"])


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
