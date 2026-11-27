"""FastAPI wrapper around run_backtest()."""
from __future__ import annotations

import asyncio
import hmac
import os
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator

from bt_service.runner import run_backtest

MAX_BODY_BYTES = 1024 * 1024
BUSY_WAIT_S = 30.0
MIN_TOKEN_LEN = 24

app = FastAPI(title="bt-service")  # deliberately no CORS middleware

_sem: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(max(1, int(os.environ.get("BT_MAX_CONCURRENCY", "1"))))
    return _sem


class BacktestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    symbols: list[str]
    start: str
    end: str
    interval: str = "1D"
    capital: float = Field(default=1_000_000, gt=0, allow_inf_nan=False)
    costs: dict[str, Any] | None = None
    source: str = "auto"
    signal_parameters: dict[str, Any] | None = None

    @field_validator("start", "end")
    @classmethod
    def _iso_date(cls, v: str) -> str:
        try:
            if len(v) != 10:
                raise ValueError
            date.fromisoformat(v)
        except ValueError:
            raise ValueError("must be an ISO date (YYYY-MM-DD)") from None
        return v


def _timeout_s() -> int:
    try:
        value = int(os.environ.get("BT_TIMEOUT_S", "120"))
    except ValueError:
        value = 120
    return min(max(value, 1), 3600)


class _BodyTooLarge(Exception):
    pass


class BodySizeLimit:
    """Pure ASGI middleware: 413 on declared or streamed bodies over MAX_BODY_BYTES."""

    def __init__(self, asgi_app):
        self.app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        too_large = JSONResponse({"error": "request body too large"}, status_code=413)
        for name, value in scope["headers"]:
            if name == b"content-length":
                try:
                    if int(value) > MAX_BODY_BYTES:
                        return await too_large(scope, receive, send)
                except ValueError:
                    pass
        total = 0
        rejected = False

        async def counting_receive():
            nonlocal total, rejected
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > MAX_BODY_BYTES and not rejected:
                    rejected = True  # answer 413 now; FastAPI would otherwise turn this into a 400
                    await too_large(scope, receive, send)
                if rejected:
                    raise _BodyTooLarge
            return message

        async def guarded_send(message):
            if not rejected:
                await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except _BodyTooLarge:
            pass


app.add_middleware(BodySizeLimit)


def require_auth(authorization: str | None = Header(default=None)) -> None:
    token = os.environ.get("BT_TOKEN", "")
    if len(token) < MIN_TOKEN_LEN:
        raise HTTPException(status_code=503, detail="BT_TOKEN not configured")
    prefix = "Bearer "
    supplied = authorization[len(prefix):] if authorization and authorization.startswith(prefix) else ""
    if not hmac.compare_digest(supplied.encode(), token.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    # Drop echoed input/ctx: NaN/Inf inputs are not JSON-serialisable and would turn a 422 into a 500.
    errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/backtest", dependencies=[Depends(require_auth)])
async def backtest(req: BacktestRequest):
    sem = _semaphore()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=BUSY_WAIT_S)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "busy"}, status_code=429)
    try:
        return await run_in_threadpool(
            run_backtest,
            code=req.code,
            symbols=req.symbols,
            start=req.start,
            end=req.end,
            interval=req.interval,
            capital=req.capital,
            costs=req.costs,
            source=req.source,
            timeout_s=_timeout_s(),
            signal_parameters=req.signal_parameters,
        )
    finally:
        sem.release()
