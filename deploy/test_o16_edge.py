"""Owner-side edge tests for O-16 (EXECUTE_MEMORY_MB exposed to trade-mcp)."""
import re
import shutil
import subprocess

import pytest
import yaml

from test_deploy import COMPOSE, ENV_EX, MIN_ENV, ROOT, compose_env_with, env_example

CONFIG_TS = ROOT / "trade-mcp" / "src" / "config.ts"
LO, HI, DEFAULT = 16, 512, 64


def _docker_ok():
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def _ts_default_and_clamp():
    src = CONFIG_TS.read_text(encoding="utf-8")
    m = re.search(
        r"executeMemoryMb\s*=.*?Math\.min\((\d+),\s*Math\.max\((\d+),.*?\)\)\s*:\s*(\d+)\s*;", src)
    assert m, "executeMemoryMb parse line not found in config.ts"
    return int(m.group(3)), int(m.group(2)), int(m.group(1))  # default, lo, hi


def _env_lines():
    return ENV_EX.read_text(encoding="utf-8").splitlines()


def _comment_block_before(var):
    """Contiguous '#' lines directly above the VAR= line."""
    lines = _env_lines()
    i = next(n for n, l in enumerate(lines) if l.strip().startswith(var + "="))
    out = []
    j = i - 1
    while j >= 0 and lines[j].lstrip().startswith("#"):
        out.insert(0, lines[j])
        j -= 1
    return "\n".join(out)


def test_config_ts_clamp_and_default_match_brief():
    assert _ts_default_and_clamp() == (DEFAULT, LO, HI)


def test_compose_trade_mcp_env_is_exact_and_only_on_trade_mcp():
    doc = yaml.safe_load(COMPOSE.read_text())
    assert doc["services"]["trade-mcp"]["environment"]["EXECUTE_MEMORY_MB"] == "${EXECUTE_MEMORY_MB:-64}"
    for name, s in doc["services"].items():
        if name != "trade-mcp":
            assert "EXECUTE_MEMORY_MB" not in (s.get("environment") or {}), name
    # No other mention anywhere else in the compose file (e.g. a second service, a stray label).
    assert COMPOSE.read_text().count("EXECUTE_MEMORY_MB") == 2  # key + ${...}


def test_compose_default_equals_config_ts_default():
    doc = yaml.safe_load(COMPOSE.read_text())
    m = re.fullmatch(r"\$\{EXECUTE_MEMORY_MB:-(\d+)\}",
                     doc["services"]["trade-mcp"]["environment"]["EXECUTE_MEMORY_MB"])
    assert m
    assert int(m.group(1)) == _ts_default_and_clamp()[0]


def test_env_example_value_inside_clamp():
    val = env_example()["EXECUTE_MEMORY_MB"]
    assert re.fullmatch(r"[0-9]+", val), val  # integer MB, no sign/space/decimal/unit
    assert LO <= int(val) <= HI
    assert sum(1 for l in _env_lines() if l.strip().startswith("EXECUTE_MEMORY_MB=")) == 1


def test_env_example_comment_names_sizing_vars_and_range():
    comment = _comment_block_before("EXECUTE_MEMORY_MB")
    assert "EXECUTE_MAX_CONCURRENT" in comment, comment
    assert "TRADE_MCP_MEM_LIMIT" in comment, comment
    assert re.search(r"\b16\s*(\.\.|-|to)\s*512\b", comment), comment
    assert re.search(r"default\s*64\b", comment, re.I), comment
    assert "memory limit exceeded" in comment, comment


def test_env_example_comment_names_a_var_compose_really_uses():
    # The comment's TRADE_MCP_MEM_LIMIT must be the variable compose reads for trade-mcp's mem_limit.
    doc = yaml.safe_load(COMPOSE.read_text())
    assert "TRADE_MCP_MEM_LIMIT" in str(doc["services"]["trade-mcp"].get("mem_limit", ""))
    assert "TRADE_MCP_MEM_LIMIT" in env_example()


@pytest.mark.skipif(not _docker_ok(), reason="docker compose unavailable")
@pytest.mark.parametrize("extra,expected", [
    ("", "64"),                           # unset -> default
    ("EXECUTE_MEMORY_MB=\n", "64"),       # empty -> default (:- covers empty)
    ("EXECUTE_MEMORY_MB=16\n", "16"),     # lower bound
    ("EXECUTE_MEMORY_MB=512\n", "512"),   # upper bound passes through
    ("EXECUTE_MEMORY_MB=1000\n", "1000"), # compose does not clamp; config.ts does
])
def test_compose_resolves_execute_memory_mb(tmp_path, monkeypatch, extra, expected):
    monkeypatch.delenv("EXECUTE_MEMORY_MB", raising=False)  # a host value would mask the default
    env = compose_env_with(MIN_ENV + extra, tmp_path, monkeypatch)
    assert env["EXECUTE_MEMORY_MB"] == expected
