"""TM2-47: container memory limits. Static (YAML + string) checks; no docker needed."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parent
COMPOSE = DEPLOY / "docker-compose.yml"
ENV_EX = DEPLOY / ".env.example"
VARS = {
    "trade-mcp": "TRADE_MCP_MEM_LIMIT",
    "bt-service": "BT_MEM_LIMIT",
    "caddy": "CADDY_MEM_LIMIT",
}
UNITS = {"m": 2**20, "g": 2**30}
MB = 2**20
BASE_RSS_MB = 100  # measured, see coord/reports/TM2-47.md
MEMORY_BYTES_MB = 64  # sandbox default (quickjs.ts)
WASM_HEADROOM_MB = 32  # ADR-19: 16 MB baseline + 16 MB headroom
PENDING_ARGS_MB = MEMORY_BYTES_MB  # ADR-18: pending binding-argument bytes cap = memoryBytes
MAX_CONCURRENT = 4  # EXECUTE_MAX_CONCURRENT default
TRADE_MCP_WORST_MB = BASE_RSS_MB + MAX_CONCURRENT * (MEMORY_BYTES_MB + WASM_HEADROOM_MB + PENDING_ARGS_MB)


def doc():
    return yaml.safe_load(COMPOSE.read_text())


def default_of(service):
    v = doc()["services"][service]["mem_limit"]
    m = re.fullmatch(r"\$\{(\w+):-(\d+)([mg])\}", str(v))
    assert m, (service, v)
    assert m.group(1) == VARS[service]
    return int(m.group(2)) * UNITS[m.group(3)]


def test_every_service_has_env_driven_limit():
    for name, var in VARS.items():
        assert doc()["services"][name]["mem_limit"].startswith("${" + var + ":-")


def test_default_sum_fits_4gb_vps():
    assert sum(default_of(n) for n in VARS) <= 2300 * MB  # rest is for OpenAlgo and the OS


def test_trade_mcp_default_covers_base_plus_four_runs():
    assert TRADE_MCP_WORST_MB == 740
    assert default_of("trade-mcp") >= TRADE_MCP_WORST_MB * MB


def test_bt_service_limit_default_is_one_gib_and_cpu_default_one():
    assert default_of("bt-service") == 2**30
    assert doc()["services"]["bt-service"]["cpus"] == "${BT_CPUS:-1}"


def test_vars_documented_in_env_example_and_runbook():
    env = ENV_EX.read_text()
    run = (DEPLOY.parent / "docs" / "vps-runbook.md").read_text()
    for var in list(VARS.values()) + ["BT_CPUS"]:
        assert re.search(rf"^{var}=\S+$", env, re.M), var
        assert var in run, var


def test_env_example_values_match_compose_defaults():
    env = dict(re.findall(r"^(\w+)=(\S*)$", ENV_EX.read_text(), re.M))
    for name, var in VARS.items():
        m = re.fullmatch(r"\$\{\w+:-(\w+)\}", doc()["services"][name]["mem_limit"])
        assert env[var] == m.group(1), var


def test_openalgo_has_no_default_memory_limit():
    o = doc()["services"]["openalgo"]
    assert "mem_limit" not in o and "memswap_limit" not in o and "deploy" not in o


def test_memswap_equals_mem_limit_for_limited_services():
    for name in VARS:
        s = doc()["services"][name]
        assert s["memswap_limit"] == s["mem_limit"], name


def _compose_config(extra_env):
    env = {**os.environ, "OPENALGO_API_KEY": "k", "MCP_TOKEN": "t", "BT_TOKEN": "b",
           "DOMAIN": "example.com", "ACME_EMAIL": "a@example.com"}
    for v in list(VARS.values()) + ["BT_CPUS"]:
        env.pop(v, None)
    env.update(extra_env)
    out = subprocess.run(["docker", "compose", "-f", str(COMPOSE), "config", "--format", "json"],
                         capture_output=True, text=True, cwd=str(DEPLOY), env=env)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)["services"]


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not available")
def test_docker_config_defaults_and_overrides_resolve():
    svcs = _compose_config({})
    want = {"trade-mcp": 2**30, "bt-service": 2**30, "caddy": 128 * MB}
    for name, b in want.items():
        assert int(svcs[name]["mem_limit"]) == b, name
        assert int(svcs[name]["memswap_limit"]) == b, name
    assert float(svcs["bt-service"]["cpus"]) == 1.0
    assert "mem_limit" not in svcs["openalgo"]
    svcs = _compose_config({"TRADE_MCP_MEM_LIMIT": "2g", "BT_MEM_LIMIT": "512m",
                            "CADDY_MEM_LIMIT": "256m", "BT_CPUS": "2"})
    assert int(svcs["trade-mcp"]["mem_limit"]) == 2 * 2**30
    assert int(svcs["trade-mcp"]["memswap_limit"]) == 2 * 2**30
    assert int(svcs["bt-service"]["mem_limit"]) == 512 * MB
    assert int(svcs["caddy"]["mem_limit"]) == 256 * MB
    assert float(svcs["bt-service"]["cpus"]) == 2.0


def test_restart_policy_and_no_published_trade_mcp_port():
    for name, s in doc()["services"].items():
        assert s["restart"] == "unless-stopped", name
    assert "ports" not in doc()["services"]["trade-mcp"]
