"""Walk-forward evaluation: pick signal parameters on train windows, score them out of sample.

Window sizes are calendar days, not trading bars: 20 calendar days is roughly 14 daily bars,
so keep `train_days` large enough for the chosen metric to be meaningful.
"""
from __future__ import annotations

import math
import os
import time
from datetime import date, timedelta

from bt_service.runner import run_backtest

MAX_CANDIDATES = 10
MIN_TRAIN_DAYS = 20
MIN_TEST_DAYS = 5
MAX_DAYS = 3650
MAX_RUNS = 60
DEFAULT_BUDGET_S = 600
MIN_BUDGET_S = 30
MAX_BUDGET_S = 3600
METRICS = ("sharpe", "total_return", "calmar")


def _finite(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _score(result, metric: str) -> float | None:
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    metrics = result.get("metrics")
    if not isinstance(metrics, dict):
        return None
    return _finite(metrics.get(metric))


def _budget_s() -> int:
    try:
        value = int(os.environ.get("BT_WALKFORWARD_BUDGET_S", str(DEFAULT_BUDGET_S)))
    except ValueError:
        value = DEFAULT_BUDGET_S
    return min(max(value, MIN_BUDGET_S), MAX_BUDGET_S)


def walk_forward(
    code: str,
    symbols: list[str],
    start: str,
    end: str,
    *,
    train_days: int,
    test_days: int,
    candidates: list[dict],
    metric: str = "sharpe",
    interval: str = "1D",
    capital: float = 1_000_000,
    costs: dict | None = None,
    source: str = "auto",
    timeout_s: int = 120,
    run=run_backtest,
    clock=time.monotonic,
) -> dict:
    if metric not in METRICS:
        return {"ok": False, "error": f"metric must be one of {', '.join(METRICS)}"}
    if (
        isinstance(train_days, bool)
        or not isinstance(train_days, int)
        or not MIN_TRAIN_DAYS <= train_days <= MAX_DAYS
    ):
        return {"ok": False, "error": f"train_days must be an integer between {MIN_TRAIN_DAYS} and {MAX_DAYS}"}
    if (
        isinstance(test_days, bool)
        or not isinstance(test_days, int)
        or not MIN_TEST_DAYS <= test_days <= MAX_DAYS
    ):
        return {"ok": False, "error": f"test_days must be an integer between {MIN_TEST_DAYS} and {MAX_DAYS}"}
    if (
        not isinstance(candidates, (list, tuple))
        or not 1 <= len(candidates) <= MAX_CANDIDATES
        or not all(isinstance(c, dict) for c in candidates)
    ):
        return {"ok": False, "error": f"candidates must be a list of 1-{MAX_CANDIDATES} dicts"}
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError):
        return {"ok": False, "error": "start and end must be ISO dates (YYYY-MM-DD)"}

    train_span, test_span = timedelta(days=train_days), timedelta(days=test_days)
    windows = []
    t0 = d0
    while True:
        try:
            tr_e = t0 + train_span
            window_end = tr_e + test_span
        except OverflowError:
            break  # no window fits before date.max
        if window_end > d1:
            break
        windows.append((t0, tr_e, tr_e, window_end))
        t0 += test_span
    if not windows:
        return {"ok": False, "error": "range too short for one fold"}
    if len(windows) * (len(candidates) + 1) > MAX_RUNS:
        return {"ok": False, "error": "too many runs"}

    deadline = clock() + _budget_s()
    folds: list[dict] = []
    oos_equity: list[dict] = []
    warnings: list[str] = []
    prev_last: float | None = None
    for i, (tr_s, tr_e, te_s, te_e) in enumerate(windows):
        best_idx: int | None = None
        best_score: float | None = None
        first_error = None
        for idx, candidate in enumerate(candidates):
            remaining = deadline - clock()
            if remaining <= 0:
                return {"ok": False, "error": "time budget exceeded", "folds": folds}
            res = run(
                code=code,
                symbols=symbols,
                start=tr_s.isoformat(),
                end=(tr_e - timedelta(days=1)).isoformat(),
                interval=interval,
                capital=capital,
                costs=costs,
                source=source,
                timeout_s=min(timeout_s, remaining),
                signal_parameters=candidate,
            )
            warnings.extend(f"fold {i}: {w}" for w in (res.get("warnings") or []))
            if first_error is None and not res.get("ok"):
                first_error = res.get("error")
            score = _score(res, metric)
            if score is not None and (best_score is None or score > best_score):
                best_idx, best_score = idx, score
        if best_idx is None:
            detail = f": {first_error}" if first_error else ""
            return {"ok": False, "error": f"fold {i}: no candidate produced a finite {metric}{detail}"}

        chosen = candidates[best_idx]
        remaining = deadline - clock()
        if remaining <= 0:
            return {"ok": False, "error": "time budget exceeded", "folds": folds}
        test_res = run(
            code=code,
            symbols=symbols,
            start=te_s.isoformat(),
            end=(te_e - timedelta(days=1)).isoformat(),
            interval=interval,
            capital=capital,
            costs=costs,
            source=source,
            timeout_s=min(timeout_s, remaining),
            signal_parameters=chosen,
        )
        warnings.extend(f"fold {i}: {w}" for w in (test_res.get("warnings") or []))
        if not test_res.get("ok"):
            return {"ok": False, "error": f"fold {i}: test run failed: {test_res.get('error', 'unknown error')}"}

        test_metrics = test_res.get("metrics")
        if not isinstance(test_metrics, dict):
            test_metrics = {}
        folds.append(
            {
                "train": [tr_s.isoformat(), tr_e.isoformat()],
                "test": [te_s.isoformat(), te_e.isoformat()],
                "chosen": chosen,
                "train_score": best_score,
                "test_metrics": test_metrics,
            }
        )

        equity = test_res.get("equity") or []
        scale = 1.0
        if prev_last is not None:
            first = _finite(equity[0].get("value")) if equity else None
            if first:
                scale = prev_last / first
            else:
                warnings.append(f"fold {i}: equity not rescaled (first value {first!r})")
        for point in equity:
            value = point.get("value")
            scaled = _finite(value)
            oos_equity.append({"date": point.get("date"), "value": scaled * scale if scaled is not None else value})
        if oos_equity:
            last = _finite(oos_equity[-1]["value"])
            if last is not None:
                prev_last = last

    test_scores: list[float] = []
    for fold in folds:
        score = _finite(fold["test_metrics"].get(metric))
        if score is not None:
            test_scores.append(score)
    mean = round(sum(test_scores) / len(test_scores), 6) if test_scores else None
    return {
        "ok": True,
        "metric": metric,
        "folds": folds,
        "oos_equity": oos_equity,
        "summary": {
            "folds": len(folds),
            f"mean_test_{metric}": mean,
            "positive_folds": sum(1 for score in test_scores if score > 0),
            "scored_folds": len(test_scores),
        },
        "warnings": warnings,
    }
