"""P2.1 extraction tests: vibe_bt is a standalone, self-contained package."""
from __future__ import annotations

import importlib
import json
import pkgutil
import re
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "vibe_bt"


# --- AC: standalone imports -------------------------------------------------

@pytest.mark.parametrize(
    "mod",
    [
        "vibe_bt.backtest.runner",
        "vibe_bt.backtest.engines.india_equity",
        "vibe_bt.backtest.engines.crypto",
    ],
)
def test_key_modules_import(mod):
    importlib.import_module(mod)


def test_every_module_imports():
    import vibe_bt

    failures = {}
    for info in pkgutil.walk_packages(vibe_bt.__path__, "vibe_bt."):
        try:
            importlib.import_module(info.name)
        except Exception as exc:  # collect, do not stop at first
            failures[info.name] = f"{type(exc).__name__}: {exc}"
    assert not failures, json.dumps(failures, indent=1)


# --- AC: no bare src./backtest. imports, no agent/LLM code --------------------

_BARE = re.compile(r"^\s*(from|import)\s+(src|backtest)\b", re.M)


def test_no_bare_src_or_backtest_imports():
    hits = []
    for py in PKG.rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        for m in _BARE.finditer(text):
            end = text.find("\n", m.start())
            hits.append(f"{py.relative_to(ROOT)}: {text[m.start():end].strip()}")
    assert not hits, "\n".join(hits)


def test_no_string_module_paths_to_bare_packages():
    # Module paths that are actually loaded: import_module("..."), __import__("..."),
    # `python -m <mod>` argv entries. (Denylist strings such as runner's
    # _FORBIDDEN_IMPORT_PREFIXES are intentionally not matched.)
    pat = re.compile(
        r"""(import_module\(\s*|__import__\(\s*|["']-m["']\s*,\s*)["'](src|backtest)\.[\w.]+["']"""
    )
    hits = []
    for py in PKG.rglob("*.py"):
        code = "\n".join(
            ln for ln in py.read_text(encoding="utf-8").splitlines()
            if not ln.lstrip().startswith("#")
        )
        hits += [f"{py.relative_to(ROOT)}: {' '.join(m.group(0).split())}" for m in pat.finditer(code)]
    assert not hits, "\n".join(hits)


@pytest.mark.parametrize(
    "forbidden",
    ["agent", "providers", "llm", "langchain", "trading", "br_data", "mcp_server"],
)
def test_no_agent_or_provider_modules_copied(forbidden):
    assert not list(PKG.rglob(forbidden)), forbidden
    assert not list(PKG.rglob(f"{forbidden}.py")), forbidden


def test_no_llm_sdk_imports():
    pat = re.compile(r"^\s*(from|import)\s+(openai|anthropic|langchain\w*|litellm)\b", re.M)
    hits = [str(p) for p in PKG.rglob("*.py") if pat.search(p.read_text(encoding="utf-8"))]
    assert not hits, hits


# --- AC: dependency set --------------------------------------------------------

def _dep_name(spec: str) -> str:
    return re.split(r"[<>=!~\[; ]", spec, maxsplit=1)[0].lower()


def _pyproject():
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_pyproject_deps_exact():
    deps = _pyproject()["project"]["dependencies"]
    assert {_dep_name(d) for d in deps} == {
        "pandas", "numpy", "scipy", "pydantic", "yfinance",
        "ccxt", "fastapi", "uvicorn", "httpx", "pyyaml",
    }
    pandas = next(d for d in deps if _dep_name(d) == "pandas")
    assert pandas.replace(" ", "") == "pandas>=3,<4"


def test_pyproject_dev_group_is_pytest_only():
    dev = _pyproject().get("dependency-groups", {}).get("dev", [])
    assert {_dep_name(d) for d in dev} == {"pytest"}


# --- AC: licence files --------------------------------------------------------

def test_license_and_notice_present():
    lic = PKG / "LICENSE"
    notice = PKG / "NOTICE"
    assert lic.is_file() and notice.is_file()
    text = lic.read_text(encoding="utf-8")
    assert "MIT" in text or "Permission is hereby granted" in text
    assert notice.read_text(encoding="utf-8").strip()


# --- AC: SHIMS.md lists every shim -------------------------------------------

@pytest.mark.parametrize(
    "shim",
    [
        "config/accessor",
        "data_gateway/reads",
        "factors/registry",
        "tools/path_utils",
        "market_data",
        "rsshub_events",
    ],
)
def test_shims_md_lists_shim(shim):
    assert shim in (PKG / "SHIMS.md").read_text(encoding="utf-8")


# --- loader registry (no network) ----------------------------------------------

def test_loader_registry_populated():
    from vibe_bt.backtest.loaders import registry

    registry._ensure_registered()
    missing = {"yfinance", "binance", "okx", "ccxt", "local"} - set(registry.LOADER_REGISTRY)
    assert not missing, f"missing loaders {missing}; have {sorted(registry.LOADER_REGISTRY)}"


def test_ensure_registered_idempotent():
    from vibe_bt.backtest.loaders import registry

    registry._ensure_registered()
    before = dict(registry.LOADER_REGISTRY)
    registry._ensure_registered()
    assert registry.LOADER_REGISTRY == before


# --- shim behaviour -----------------------------------------------------------

@pytest.mark.parametrize(
    "unc", ["\\\\server\\share", "\\\\server\\share\\run", "//server/share/run", "\\\\?\\C:\\x"]
)
def test_safe_run_dir_rejects_unc(unc):
    from vibe_bt.src.tools.path_utils import safe_run_dir

    with pytest.raises(ValueError):
        safe_run_dir(unc)


def test_safe_run_dir_resolves_local(tmp_path):
    from vibe_bt.src.tools.path_utils import safe_run_dir

    out = safe_run_dir(str(tmp_path / "a" / ".." / "b"))
    assert out == (tmp_path / "b").resolve()
    assert out.is_absolute()


@pytest.mark.skipif(sys.platform != "win32", reason="backslash is a path separator only on Windows")
def test_safe_run_dir_windows_backslash_path(tmp_path):
    from vibe_bt.src.tools.path_utils import safe_run_dir

    assert safe_run_dir(str(tmp_path).replace("/", "\\")) == tmp_path.resolve()


@pytest.mark.skipif(sys.platform == "win32", reason="on Windows backslash is a path separator")
def test_safe_run_dir_posix_backslash_is_filename_char(tmp_path, monkeypatch):
    from vibe_bt.src.tools.path_utils import safe_run_dir

    monkeypatch.chdir(tmp_path)
    result = safe_run_dir("a\\b")
    assert result == tmp_path.resolve() / "a\\b"
    assert len(result.relative_to(tmp_path.resolve()).parts) == 1


def test_identity_decorators_keep_return_values():
    from vibe_bt.src.data_gateway.reads import availability_probe, loader_read, managed_reader

    def f(x, y=1):
        return {"v": x + y}

    assert loader_read(f) is f
    assert managed_reader(f) is f
    assert loader_read(f)(1, y=2) == {"v": 3}
    assert availability_probe(f)(1) == {"v": 2}
    assert availability_probe(lambda: None)() is None


@pytest.mark.parametrize("exc", [TimeoutError, OSError, ConnectionError])
def test_availability_probe_returns_false_on_io_errors(exc):
    from vibe_bt.src.data_gateway.reads import availability_probe

    def boom():
        raise exc("x")

    assert availability_probe(boom)() is False


def test_availability_probe_propagates_other_errors():
    from vibe_bt.src.data_gateway.reads import availability_probe

    def boom():
        raise ValueError("x")

    with pytest.raises(ValueError):
        availability_probe(boom)()


@pytest.mark.parametrize("alpha_id", ["momentum_12_1", "", None])
def test_factor_registry_get_raises_keyerror(alpha_id):
    from vibe_bt.src.factors.registry import get_default_registry

    with pytest.raises(KeyError):
        get_default_registry().get(alpha_id)


def test_env_config_accessor(monkeypatch):
    from vibe_bt.src.config.accessor import get_env_config

    monkeypatch.delenv("CCXT_EXCHANGE", raising=False)
    monkeypatch.delenv("TUSHARE_TOKEN", raising=False)
    cfg = get_env_config()
    assert cfg.data.ccxt_exchange == "binance"
    assert cfg.data.tushare_token == ""
    monkeypatch.setenv("TUSHARE_TOKEN", "abc")
    assert get_env_config().data.tushare_token == "abc"


def test_market_data_shim():
    from vibe_bt.src import market_data

    assert "USD" in market_data.FIAT_CODES
    assert callable(market_data.canonical_fx_pair)


# --- offline end-to-end smoke ---------------------------------------------------

SIGNAL_ENGINE = '''
from typing import Dict

import pandas as pd


class SignalEngine:
    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        return {code: pd.Series(1.0, index=df.index) for code, df in data_map.items()}
'''


def test_offline_end_to_end_smoke(tmp_path, monkeypatch):
    import numpy as np
    import pandas as pd

    from vibe_bt.backtest import runner
    from vibe_bt.backtest.loaders import local_loader

    for var in ("HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")  # accidental network fails fast
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")

    dates = pd.bdate_range("2024-01-02", periods=120)
    close = 100 + np.cumsum(np.linspace(0.1, 0.3, len(dates)))
    csv = tmp_path / "data" / "aapl.csv"
    csv.parent.mkdir()
    pd.DataFrame(
        {
            "date": dates.strftime("%Y-%m-%d"),
            "open": close,
            "high": close + 1,
            "low": close - 1,
            "close": close,
            "volume": 1_000_000,
        }
    ).to_csv(csv, index=False)

    cfg_yaml = tmp_path / "bridge" / "config.yaml"
    cfg_yaml.parent.mkdir()
    cfg_yaml.write_text(
        "sources:\n"
        '  - symbol: "AAPL.US"\n'
        "    type: csv\n"
        f'    path: "{csv.as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(local_loader, "_CONFIG_PATH", cfg_yaml)

    run_dir = tmp_path / "run"
    (run_dir / "code").mkdir(parents=True)
    (run_dir / "code" / "signal_engine.py").write_text(SIGNAL_ENGINE, encoding="utf-8")
    (run_dir / "config.json").write_text(
        json.dumps(
            {
                "source": "local",
                "codes": ["AAPL.US"],
                "start_date": "2024-01-02",
                "end_date": "2024-06-14",
                "interval": "1D",
                "engine": "daily",
            }
        ),
        encoding="utf-8",
    )

    runner.main(run_dir)

    assert (run_dir / "artifacts" / "equity.csv").is_file()
    assert (run_dir / "artifacts" / "metrics.csv").is_file()
    assert len(pd.read_csv(run_dir / "artifacts" / "equity.csv")) > 0


def test_main_rejects_unc_run_dir(capsys):
    from vibe_bt.backtest import runner

    with pytest.raises(SystemExit) as ei:
        runner.main(Path("\\\\server\\share\\run"))
    assert ei.value.code == 1
    assert "UNC" in capsys.readouterr().out


def test_main_missing_config(tmp_path, capsys):
    from vibe_bt.backtest import runner

    with pytest.raises(SystemExit):
        runner.main(tmp_path)
    assert "config.json not found" in capsys.readouterr().out
