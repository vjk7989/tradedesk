"""TM2-77: paper orders through OpenAlgo's Analyzer (sandbox). Only imported when EXECUTION=openalgo.

Wire shapes mirror trade-mcp/src/openalgo/client.ts (see coord/reports/TM2-77.md): POST {base}/api/v1/<endpoint>,
JSON body with "apikey" inside the body, success = HTTP 2xx + JSON {"status": "success", ...}.

Safety: analyzer must be ON (data.analyze_mode is True) at startup and again immediately before EVERY order. Any
error, timeout, odd shape or analyzer-off means no order. An order is sent at most once, never retried.
"""
import logging
import math

import httpx

log = logging.getLogger("paper_bot")

STRATEGY = "paper-bot"
EXCHANGE = "CRYPTO"  # trade-mcp api-docs.ts:9 (Delta via OpenAlgo)
PRODUCT = "NRML"  # api-docs.ts:11: Delta ignores the product; NRML/MIS are the values trade-mcp allows
PRICETYPE = "MARKET"

OK, REJECTED, UNKNOWN, REFUSED = "ok", "rejected", "unknown", "refused"


class OpenAlgoError(Exception):
    """Transport/shape failure talking to OpenAlgo. `sent` = the request may have reached the server."""

    def __init__(self, msg, sent=True):
        super().__init__(msg)
        self.sent = sent


class Result:
    def __init__(self, status, reason="", orderid=None):
        self.status, self.reason, self.orderid = status, reason, orderid


class OpenAlgoExec:
    def __init__(self, cfg):
        problems = cfg.openalgo_problems()
        if problems:
            raise ValueError("invalid config: " + "; ".join(problems))
        self._key = cfg.openalgo_api_key
        self.base = cfg.openalgo_url.rstrip("/")
        self.timeout = float(cfg.openalgo_timeout)
        self.sizes = dict(cfg.contract_sizes)
        self.suffix = cfg.openalgo_symbol_suffix

    def __repr__(self):
        return "OpenAlgoExec()"

    def _redact(self, s):
        return str(s).replace(self._key, "[REDACTED]")

    def _call(self, endpoint, body):
        """POST; returns parsed JSON dict with status == success, else raises OpenAlgoError (mirrors client.ts call)."""
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=False) as c:
                r = c.post(f"{self.base}/api/v1/{endpoint}", json={**body, "apikey": self._key})
        except httpx.ConnectError as e:  # connection never established: the request was not delivered
            raise OpenAlgoError(f"connect error {type(e).__name__}", sent=False) from None
        except httpx.TimeoutException:
            raise OpenAlgoError(f"request timeout after {self.timeout:g}s") from None
        except Exception as e:
            raise OpenAlgoError(f"network error {type(e).__name__}") from None
        try:
            j = r.json()
        except ValueError:
            raise OpenAlgoError(f"HTTP {r.status_code}: non-JSON response body") from None
        msg = self._redact(str(j.get("message", ""))[:120]) if isinstance(j, dict) else ""
        if not r.is_success:
            e = OpenAlgoError(f"HTTP {r.status_code}: {msg or 'error'}")
            e.http = r.status_code
            e.definite = isinstance(j, dict) and j.get("status") == "error" and 400 <= r.status_code < 500
            raise e
        if not isinstance(j, dict) or j.get("status") != "success":
            e = OpenAlgoError(msg or "OpenAlgo returned status error")
            e.definite = isinstance(j, dict) and j.get("status") == "error"
            raise e
        return j

    def analyzer_on(self):
        """True only if OpenAlgo says analyze_mode is exactly true. Raises OpenAlgoError on anything unexpected."""
        j = self._call("analyzer", {})
        d = j.get("data")
        if not isinstance(d, dict) or not isinstance(d.get("analyze_mode"), bool):
            raise OpenAlgoError("unexpected analyzer status shape")
        return d["analyze_mode"]

    def require_analyzer_on(self):
        """Startup gate: refuse to start unless analyzer is ON."""
        try:
            on = self.analyzer_on()
        except OpenAlgoError as e:
            raise RuntimeError(f"EXECUTION=openalgo refused to start: analyzer status check failed ({e})") from None
        if not on:
            raise RuntimeError("EXECUTION=openalgo refused to start: OpenAlgo analyzer is OFF "
                               "(live mode); turn Analyzer ON first")
        log.info("openalgo analyzer is ON; execution through the sandbox")

    def contract_size(self, sym):
        return self.sizes[sym]

    def symbol(self, sym):
        return sym + self.suffix

    def place(self, sym, side, contracts):
        """side BUY/SELL, contracts: positive int. Re-checks analyzer first; sends at most one request."""
        if side not in ("BUY", "SELL") or not isinstance(contracts, int) or contracts < 1:
            return Result(REFUSED, f"invalid order ({side}, {contracts}): order refused")
        try:
            on = self.analyzer_on()
        except OpenAlgoError as e:
            return Result(REFUSED, f"openalgo analyzer check failed ({e}): order refused")
        if not on:
            return Result(REFUSED, "openalgo analyzer off: order refused")
        body = {"strategy": STRATEGY, "symbol": self.symbol(sym), "exchange": EXCHANGE, "action": side,
                "pricetype": PRICETYPE, "product": PRODUCT, "quantity": contracts}
        try:
            j = self._call("placeorder", body)
        except OpenAlgoError as e:
            if not e.sent:
                return Result(REJECTED, f"order not sent ({e})")
            if getattr(e, "definite", False):
                return Result(REJECTED, f"rejected by openalgo: {e}")
            return Result(UNKNOWN, f"order outcome unknown, not retried ({e})")
        oid = j.get("orderid")
        if not isinstance(oid, (str, int)) or isinstance(oid, bool) or not str(oid).strip():
            return Result(UNKNOWN, "order outcome unknown, not retried (success without orderid)")
        return Result(OK, "", self._redact(str(oid))[:64])


def contracts_for(units, size):
    """Units -> whole contracts, rounded DOWN (never exceeds the intended notional). 0 means refuse."""
    if not (math.isfinite(units) and units > 0 and size > 0):
        return 0
    return int(math.floor(units / size + 1e-9))
