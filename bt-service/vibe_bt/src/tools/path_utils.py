"""Minimal shim for safe_run_dir: rejects UNC paths, otherwise resolves the path."""
from __future__ import annotations

from pathlib import Path


def safe_run_dir(p: str) -> Path:
    if p.startswith("\\\\") or p.startswith("//"):
        raise ValueError(f"UNC paths are not allowed: {p!r}")
    return Path(p).expanduser().resolve()
