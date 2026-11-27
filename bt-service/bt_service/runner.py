"""run_backtest(): validate, AST-check, run Vibe's engine in a child process, parse artifacts."""
from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import date
from pathlib import Path
from typing import Any

MAX_CODE_BYTES = 100 * 1024
MAX_EQUITY_POINTS = 500
MAX_TRADES = 1000
_ENV_ALLOW = {
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY",
    "NO_PROXY", "BT_LOCAL_DATA_CONFIG", "VIBE_TRADING_DATA_CACHE", "VIBE_TRADING_DATA_CACHE_ROOT",
}
# Data-source credentials the loaders read.
_ENV_PREFIXES = (
    "OPENALGO_", "TUSHARE_", "FINNHUB_", "ALPHAVANTAGE_", "FMP_", "TIINGO_", "TICKERALL_",
    "CCXT_", "MARKET_DATA_ORDER_",
)


def _fail(error: str, warnings: list[str] | None = None) -> dict[str, Any]:
    return {"ok": False, "metrics": {}, "equity": [], "trades": [], "warnings": warnings or [], "error": error}


def _validate(code, symbols, start, end, capital) -> str | None:
    if not isinstance(code, str) or not code.strip():
        return "code must be a non-empty string"
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        return "code exceeds 100KB"
    if not isinstance(symbols, list) or not 1 <= len(symbols) <= 20 or not all(
        isinstance(s, str) and s.strip() for s in symbols
    ):
        return "symbols must be a list of 1-20 non-empty strings"
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError):
        return "start and end must be ISO dates (YYYY-MM-DD)"
    if d0 >= d1:
        return "start must be before end"
    if isinstance(capital, bool) or not isinstance(capital, (int, float)) or not capital > 0 or capital == float("inf"):
        return "capital must be a positive number"
    return None


def _runs_root() -> Path:
    root = Path(os.environ.get("BT_RUNS_DIR") or Path(tempfile.gettempdir()) / "bt-runs")
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _child_env(run_dir: Path | None = None) -> dict[str, str]:
    env = {
        k: v for k, v in os.environ.items()
        if k.upper() in _ENV_ALLOW or k.upper().startswith(_ENV_PREFIXES)
    }
    # Library caches must stay inside run_dir (the child audit hook blocks other writes).
    if run_dir is not None:
        env["XDG_CACHE_HOME"] = str(run_dir / ".cache")
    return env


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _num(v: str):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _parse(run_dir: Path, warnings: list[str]) -> dict[str, Any]:
    art = run_dir / "artifacts"
    equity_rows = _read_csv(art / "equity.csv")
    date_key = val_key = None
    if equity_rows:
        cols = list(equity_rows[0])
        date_key = "timestamp" if "timestamp" in cols else cols[0]
        val_key = "equity" if "equity" in cols else cols[1]
    equity = [{"date": r[date_key], "value": _num(r[val_key])} for r in equity_rows]
    if len(equity) > MAX_EQUITY_POINTS:
        step = (len(equity) - 1) / (MAX_EQUITY_POINTS - 1)
        equity = [equity[round(i * step)] for i in range(MAX_EQUITY_POINTS)]
        warnings.append(f"equity downsampled to {MAX_EQUITY_POINTS} points")
    trades = [{k: _num(v) for k, v in r.items()} for r in _read_csv(art / "trades.csv")]
    if len(trades) > MAX_TRADES:
        warnings.append(f"trades truncated to {MAX_TRADES} of {len(trades)}")
        trades = trades[:MAX_TRADES]
    metrics: dict[str, Any] = {}
    for r in _read_csv(art / "metrics.csv"):
        metrics.update({k: _num(v) for k, v in r.items()})
    return {"metrics": metrics, "equity": equity, "trades": trades}


def _tail(proc) -> str:
    return "\n".join((proc.stderr or proc.stdout or "").strip().splitlines()[-20:])


def run_backtest(
    code: str,
    symbols: list[str],
    start: str,
    end: str,
    interval: str = "1D",
    capital: float = 1_000_000,
    costs: dict | None = None,
    source: str = "auto",
    timeout_s: int = 120,
    signal_parameters: dict | None = None,
) -> dict:
    err = _validate(code, symbols, start, end, capital)
    if err:
        return _fail(err)

    root = _runs_root()
    run_dir = (root / uuid.uuid4().hex).resolve()
    if not run_dir.is_relative_to(root):  # defensive: confinement is ours now
        return _fail("run_dir escapes BT_RUNS_DIR")
    (run_dir / "code").mkdir(parents=True)
    try:
        signal_file = run_dir / "code" / "signal_engine.py"
        signal_file.write_text(code, encoding="utf-8")

        from vibe_bt.backtest.runner import _validate_signal_engine_source

        try:
            _validate_signal_engine_source(signal_file)
        except Exception as exc:  # noqa: BLE001 - reason is surfaced to the caller
            return _fail(f"signal engine rejected: {exc}")

        config = {
            **(costs or {}),
            "codes": symbols,
            "start_date": start,
            "end_date": end,
            "source": source,
            "interval": interval,
            "initial_cash": capital,
            "signal_parameters": signal_parameters or {},
        }
        (run_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")

        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-m", "bt_service._child", str(run_dir)],
                capture_output=True, text=True, timeout=timeout_s, env=_child_env(run_dir), cwd=str(run_dir),
            )
        except subprocess.TimeoutExpired:
            return _fail("timeout")

        if proc.returncode != 0:
            return _fail(f"backtest failed (exit {proc.returncode}): {_tail(proc)}")
        if not (run_dir / "artifacts" / "equity.csv").is_file():
            return _fail(f"backtest produced no equity artifact: {_tail(proc)}")
        warnings: list[str] = []
        return {"ok": True, **_parse(run_dir, warnings), "warnings": warnings}
    finally:
        if os.environ.get("BT_KEEP_RUNS") != "1":
            shutil.rmtree(run_dir, ignore_errors=True)
