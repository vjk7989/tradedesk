import time

import httpx


class DataError(Exception):
    pass


async def fetch_candles(client: httpx.AsyncClient, base_url, symbol, resolution, period, count, now=None):
    """Delta India public candles. Returns [{time,open,high,low,close,volume}] (API gives newest first)."""
    now = int(now or time.time())
    try:
        r = await client.get(f"{base_url}/v2/history/candles", timeout=10.0, params={
            "symbol": symbol, "resolution": resolution, "start": now - period * count, "end": now})
    except httpx.HTTPError as e:
        raise DataError(f"{type(e).__name__} {e}"[:80])
    if r.status_code != 200:
        raise DataError(f"http {r.status_code}")
    try:
        res = r.json()["result"]
        out = [{"time": int(c["time"]), "open": float(c["open"]), "high": float(c["high"]),
                "low": float(c["low"]), "close": float(c["close"]), "volume": float(c.get("volume", 0))}
               for c in res]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise DataError("malformed response")
    if not out:
        raise DataError("empty candles")
    return out
