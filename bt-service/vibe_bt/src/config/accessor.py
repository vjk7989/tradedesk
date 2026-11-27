"""Env-var shim for vibe_bt (replaces Vibe-Trading's pydantic EnvConfig)."""
from __future__ import annotations

import os
from types import SimpleNamespace

_DEFAULTS = {"ccxt_exchange": "binance"}
_BOOLS = {"vibe_trading_data_cache"}


class _Data:
    """Attribute access reads the upper-cased env var; unset -> "" (or a default)."""

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        raw = os.getenv(name.upper())
        if name in _BOOLS:
            return (raw or "").strip().lower() in {"1", "true", "yes", "on"}
        return raw if raw else _DEFAULTS.get(name, "")


def get_env_config():
    return SimpleNamespace(data=_Data())


def get_env_value(name: str, default: str = "") -> str:
    return os.getenv(name, default)
