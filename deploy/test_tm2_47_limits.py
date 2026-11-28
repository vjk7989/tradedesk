"""TM2-47: container memory limits. Static (YAML + string) checks; no docker needed."""
import re
from pathlib import Path

import yaml

DEPLOY = Path(__file__).resolve().parent
COMPOSE = DEPLOY / "docker-compose.yml"
ENV_EX = DEPLOY / ".env.example"
VARS = {
    "openalgo": "OPENALGO_MEM_LIMIT",
    "trade-mcp": "TRADE_MCP_MEM_LIMIT",
    "bt-service": "BT_MEM_LIMIT",
    "caddy": "CADDY_MEM_LIMIT",
}
UNITS = {"m": 2**20, "g": 2**30}
MB = 2**20
BASE_RSS_MB = 100  # measured, see coord/reports/TM2-47.md


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
    assert sum(default_of(n) for n in VARS) <= 3 * 2**30


def test_trade_mcp_default_covers_base_plus_four_runs():
    # ADR-19: base + N x (memoryBytes 64 MB + 32 MB) = 100 + 4 x 96 = 484 MB
    assert default_of("trade-mcp") >= (BASE_RSS_MB + 4 * (64 + 32)) * MB


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


def test_restart_policy_and_no_published_trade_mcp_port():
    for name, s in doc()["services"].items():
        assert s["restart"] == "unless-stopped", name
    assert "ports" not in doc()["services"]["trade-mcp"]
