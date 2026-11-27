"""Owner-side edge tests for TM-12 (EXECUTE_TIMEOUT_MS exposed to trade-mcp)."""
import re
import shutil
import subprocess

import pytest
import yaml

from test_deploy import COMPOSE, ENV_EX, MIN_ENV, ROOT, compose_env_with, env_example

RUNBOOK = ROOT / "docs" / "vps-runbook.md"
TS_DEFAULT = 60000  # trade-mcp/src/config.ts default


def _docker_ok():
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def test_compose_trade_mcp_env_has_execute_timeout_default_60000():
    # Static check (works without docker): exactly this interpolation, only on trade-mcp.
    doc = yaml.safe_load(COMPOSE.read_text())
    assert doc["services"]["trade-mcp"]["environment"]["EXECUTE_TIMEOUT_MS"] == "${EXECUTE_TIMEOUT_MS:-60000}"
    assert TS_DEFAULT == 60000
    for name, s in doc["services"].items():
        if name != "trade-mcp":
            assert "EXECUTE_TIMEOUT_MS" not in (s.get("environment") or {}), name


def test_env_example_value_inside_clamp_and_documented():
    val = env_example()["EXECUTE_TIMEOUT_MS"]
    assert re.fullmatch(r"[0-9]+", val), val
    assert 5000 <= int(val) <= 900000
    lines = ENV_EX.read_text().splitlines()
    i = next(n for n, l in enumerate(lines) if l.strip().startswith("EXECUTE_TIMEOUT_MS="))
    comment = " ".join(l for l in lines[max(0, i - 3):i] if l.lstrip().startswith("#"))
    assert "5000" in comment and "900000" in comment
    assert "660000" in comment and "walkForward" in comment
    assert re.search(r"client", comment, re.I) and re.search(r"timeout", comment, re.I)


def test_runbook_mentions_660000_and_client_timeouts():
    text = RUNBOOK.read_text(encoding="utf-8")
    line = next((l for l in text.splitlines() if "EXECUTE_TIMEOUT_MS" in l), "")
    assert "660000" in line
    assert "walkForward" in line
    assert re.search(r"client[s]?.{0,40}timeout", line, re.I), line


@pytest.mark.skipif(not _docker_ok(), reason="docker compose unavailable")
@pytest.mark.parametrize("extra,expected", [
    ("", "60000"),                          # unset -> default
    ("EXECUTE_TIMEOUT_MS=\n", "60000"),     # empty -> default (:- covers empty)
    ("EXECUTE_TIMEOUT_MS=660000\n", "660000"),
    ("EXECUTE_TIMEOUT_MS=900000\n", "900000"),
])
def test_compose_resolves_execute_timeout(tmp_path, monkeypatch, extra, expected):
    monkeypatch.delenv("EXECUTE_TIMEOUT_MS", raising=False)  # a host value would mask the default
    env = compose_env_with(MIN_ENV + extra, tmp_path, monkeypatch)
    assert env["EXECUTE_TIMEOUT_MS"] == expected
