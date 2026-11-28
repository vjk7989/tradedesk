"""TM2-81: Wilder RSI mean-reversion signal. Pure functions; engine/fill/fee/recovery code is shared with sma_cross."""


def wilder_rsi(closes, n):
    """Wilder RSI(n) of the LAST close. Needs n+1 closes (n price changes).
    Seed: simple average of the first n gains / losses; then avg = (prev*(n-1) + cur) / n.
    Edge cases: avg_loss == 0 and avg_gain > 0 -> 100; avg_gain == 0 and avg_loss > 0 -> 0;
    both zero (flat prices) -> 50 (neutral: no trade either way)."""
    if len(closes) < n + 1:
        raise ValueError(f"need {n + 1} closed candles, got {len(closes)}")
    ch = [b - a for a, b in zip(closes, closes[1:])]
    ag = sum(max(c, 0.0) for c in ch[:n]) / n
    al = sum(max(-c, 0.0) for c in ch[:n]) / n
    for c in ch[n:]:
        ag = (ag * (n - 1) + max(c, 0.0)) / n
        al = (al * (n - 1) + max(-c, 0.0)) / n
    if al == 0:
        return 50.0 if ag == 0 else 100.0
    return 100.0 - 100.0 / (1 + ag / al)


def evaluate_rsi(closes, n, low, high, cur, allow_short):
    """Return (signal, rsi, None, reason). signal in up (go long) / down (go short) / flat (exit) / none.
    cur = current position side ('long'/'short'/None). closes must be CLOSED candles only.
    Exits: long exits at RSI > 50, short exits at RSI < 50 (symmetric). Entry takes priority over exit
    (short and RSI < low -> reverse to long). Long with RSI > high exits to flat only (short entry needs flat)."""
    if len(closes) < n + 1:
        return "none", None, None, f"RSI({n}): need {n + 1} closed candles, got {len(closes)} → hold"
    r = wilder_rsi(closes, n)
    t = f"RSI({n})={r:.2f}"
    if r < low:
        return "up", r, None, f"{t} < {low:g} → long"
    if cur == "long" and r > 50:
        return "flat", r, None, f"{t} > 50 → exit long"
    if cur == "short" and r < 50:
        return "flat", r, None, f"{t} < 50 → exit short"
    if r > high and cur is None and allow_short:
        return "down", r, None, f"{t} > {high:g} → short"
    return "none", r, None, f"{t} no signal"
