"""Owner-side edge tests for O-11 (EXECUTE_MAX_CONCURRENT exposed to trade-mcp)."""
import re
import shutil
import subprocess

import pytest
import yaml

from test_deploy import COMPOSE, ENV_EX, MIN_ENV, ROOT, compose_env_with, env_example

RUNBOOK = ROOT / "docs" / "vps-runbook.md"
TROUBLE = ROOT / "docs" / "troubleshooting.md"
CONFIG_TS = ROOT / "trade-mcp" / "src" / "config.ts"
SERVER_TS = ROOT / "trade-mcp" / "src" / "server.ts"
LO, HI = 1, 32


def _docker_ok():
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def _ts_default_and_clamp():
    src = CONFIG_TS.read_text(encoding="utf-8")
    m = re.search(
        r"executeMaxConcurrent\s*=.*?Math\.min\((\d+),\s*Math\.max\((\d+),.*?\)\)\s*:\s*(\d+)\s*;", src)
    assert m, "executeMaxConcurrent parse line not found in config.ts"
    return int(m.group(3)), int(m.group(2)), int(m.group(1))  # default, lo, hi


def _busy_message():
    m = re.search(r'error:\s*"(busy:[^"]*)"', SERVER_TS.read_text(encoding="utf-8"))
    assert m, "busy message not found in server.ts"
    return m.group(1)


def test_config_ts_clamp_matches_documented_range():
    default, lo, hi = _ts_default_and_clamp()
    assert (lo, hi) == (LO, HI)
    assert lo <= default <= hi


def test_compose_trade_mcp_env_is_exact_and_only_on_trade_mcp():
    doc = yaml.safe_load(COMPOSE.read_text())
    assert doc["services"]["trade-mcp"]["environment"]["EXECUTE_MAX_CONCURRENT"] == "${EXECUTE_MAX_CONCURRENT:-4}"
    for name, s in doc["services"].items():
        if name != "trade-mcp":
            assert "EXECUTE_MAX_CONCURRENT" not in (s.get("environment") or {}), name


def test_compose_default_equals_config_ts_default():
    doc = yaml.safe_load(COMPOSE.read_text())
    m = re.fullmatch(r"\$\{EXECUTE_MAX_CONCURRENT:-(\d+)\}",
                     doc["services"]["trade-mcp"]["environment"]["EXECUTE_MAX_CONCURRENT"])
    assert m
    assert int(m.group(1)) == _ts_default_and_clamp()[0]


def test_env_example_value_inside_clamp_and_documented():
    val = env_example()["EXECUTE_MAX_CONCURRENT"]
    assert re.fullmatch(r"[0-9]+", val), val  # integer, no sign/space/decimal
    assert LO <= int(val) <= HI
    lines = ENV_EX.read_text().splitlines()
    assert sum(1 for l in lines if l.strip().startswith("EXECUTE_MAX_CONCURRENT=")) == 1
    i = next(n for n, l in enumerate(lines) if l.strip().startswith("EXECUTE_MAX_CONCURRENT="))
    comment = lines[i - 1] if i and lines[i - 1].lstrip().startswith("#") else ""
    assert re.search(r"\b1\s*(\.\.|-|to)\s*32\b", comment), comment
    assert re.search(r"default\s*4\b", comment, re.I), comment
    assert re.search(r"\d+\s*MB", comment) and re.search(r"run|slot", comment, re.I), comment


def test_troubleshooting_quotes_exact_busy_message():
    msg = _busy_message()
    assert f"`{msg}`" in TROUBLE.read_text(encoding="utf-8")


def test_runbook_busy_quotes_are_accurate():
    # Whatever the runbook quotes must be (a prefix of) the real message.
    msg = _busy_message()
    line = next((l for l in RUNBOOK.read_text(encoding="utf-8").splitlines()
                 if "EXECUTE_MAX_CONCURRENT" in l), "")
    quotes = [q for q in re.findall(r'["`]([^"`]*busy[^"`]*)["`]', line)]
    assert quotes, line
    for q in quotes:
        assert msg.startswith(q), q


@pytest.mark.xfail(strict=True, reason="runbook quotes a truncated busy message (O-11 follow-up)")
def test_runbook_quotes_exact_busy_message():
    assert _busy_message() in RUNBOOK.read_text(encoding="utf-8")


@pytest.mark.skipif(not _docker_ok(), reason="docker compose unavailable")
@pytest.mark.parametrize("extra,expected", [
    ("", "4"),                                # unset -> default
    ("EXECUTE_MAX_CONCURRENT=\n", "4"),       # empty -> default (:- covers empty)
    ("EXECUTE_MAX_CONCURRENT=1\n", "1"),      # lower bound
    ("EXECUTE_MAX_CONCURRENT=32\n", "32"),    # upper bound passes through
])
def test_compose_resolves_execute_max_concurrent(tmp_path, monkeypatch, extra, expected):
    monkeypatch.delenv("EXECUTE_MAX_CONCURRENT", raising=False)  # a host value would mask the default
    env = compose_env_with(MIN_ENV + extra, tmp_path, monkeypatch)
    assert env["EXECUTE_MAX_CONCURRENT"] == expected
