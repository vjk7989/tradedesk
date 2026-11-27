"""Subprocess entry: ``python -I -m bt_service._child <run_dir>``.

Installs an audit hook (defence in depth behind the AST check) before running the engine.
"""
import os
import sys
from pathlib import Path

_BLOCKED = {
    "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.kill", "os.killpg",
    "subprocess.Popen", "shutil.rmtree", "winreg.OpenKey",
}
_BLOCKED_PREFIXES = ("os.exec", "os.spawn")
_STACK_GATED_PREFIXES = ("ctypes.",)  # libraries (platformdirs) use ctypes legitimately; block only under user code
_FS_MUTATE = {"os.remove", "os.rmdir", "os.rename", "os.mkdir"}  # os.unlink audits as os.remove


def _from_user_code() -> bool:
    frame = sys._getframe(2)
    while frame is not None:
        if os.path.basename(frame.f_code.co_filename) == "signal_engine.py":
            return True
        frame = frame.f_back
    return False


def _inside(root: Path, path) -> bool:
    try:
        return Path(os.fsdecode(path)).resolve().is_relative_to(root)
    except (TypeError, ValueError, OSError):
        return False


def _install_audit_hook(run_dir: Path) -> None:
    root = run_dir.resolve()

    def hook(event: str, args: tuple) -> None:
        if event in _BLOCKED or event.startswith(_BLOCKED_PREFIXES):
            raise RuntimeError(f"blocked by sandbox: {event}")
        if event.startswith(_STACK_GATED_PREFIXES) and _from_user_code():
            raise RuntimeError(f"blocked by sandbox: {event}")
        if event in _FS_MUTATE:
            targets = [a for a in args[:2] if isinstance(a, (str, bytes, os.PathLike))]
            if not all(_inside(root, t) for t in targets):
                raise RuntimeError(f"blocked by sandbox: {event} outside run_dir")
        elif event == "open":
            path, mode, flags = args[0], args[1], args[2]
            writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC)
            )
            if writes and isinstance(path, (str, bytes, os.PathLike)) and not _inside(root, path):
                raise RuntimeError("blocked by sandbox: write outside run_dir")

    sys.addaudithook(hook)


def _setup_cache(run_dir: Path) -> Path:
    """Create <run_dir>/.cache and point yfinance's cache there (before the audit hook)."""
    cache = run_dir / ".cache"
    cache.mkdir(exist_ok=True)
    try:  # yfinance resolves its cache dir at import
        import yfinance

        yfinance.set_tz_cache_location(str(cache))
    except Exception:
        pass
    return cache


if __name__ == "__main__":
    from vibe_bt.backtest.runner import main

    run_dir = Path(sys.argv[1])
    _setup_cache(run_dir)
    _install_audit_hook(run_dir)
    main(run_dir)
