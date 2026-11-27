"""Pass-through shim for the Vibe-Trading data gateway (no pooling/caching)."""
from __future__ import annotations

from functools import wraps


def loader_read(function):
    return function


def managed_reader(function):
    return function


def availability_probe(function):
    @wraps(function)
    def probe(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (TimeoutError, OSError):
            return False

    return probe
