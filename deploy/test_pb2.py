"""PB-2: paper-bot deploy wiring. Static checks; docker config check skipped without Docker."""
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parent
COMPOSE = DEPLOY / "docker-compose.yml"
ENV_EX = DEPLOY / ".env.example"
VARS = ["SYMBOLS", "RESOLUTION", "INTERVAL_SEC", "FAST", "SLOW", "ALLOW_SHORT", "NOTIONAL_USD",
        "START_CAPITAL_USD", "TAKER_FEE", "SLIPPAGE", "DELTA_BASE_URL", "DASH_USER",
        "DASH_PASSWORD_HASH", "PAPER_BOT_MEM_LIMIT"]


def svc():
    return yaml.safe_load(COMPOSE.read_text())["services"]["paper-bot"]


def test_internal_only_no_ports():
    s = svc()
    assert s["networks"] == ["internal"]
    assert "ports" not in s


def test_limits_healthcheck_volume():
    s = svc()
    assert s["mem_limit"] == "${PAPER_BOT_MEM_LIMIT:-256m}" == s["memswap_limit"]
    assert "8090/healthz" in " ".join(s["healthcheck"]["test"])
    assert "paper_bot_data:/data" in s["volumes"]
    assert s["restart"] == "unless-stopped"


def test_caddy_gets_dash_credentials():
    env = yaml.safe_load(COMPOSE.read_text())["services"]["caddy"]["environment"]
    assert "DASH_USER" in env and "DASH_PASSWORD_HASH" in env


def test_caddy_basic_auth_before_proxy():
    t = (DEPLOY / "Caddyfile").read_text()
    block = t[t.index("dash.{$DOMAIN}"):]
    assert 0 <= block.index("basic_auth") < block.index("reverse_proxy paper-bot:8090")


def test_env_example_has_vars():
    names = {l.split("=")[0] for l in ENV_EX.read_text().splitlines() if "=" in l and not l.startswith("#")}
    assert set(VARS) <= names


@pytest.mark.skipif(shutil.which("docker") is None, reason="no docker")
def test_compose_config_resolves():
    r = subprocess.run(["docker", "compose", "-f", str(COMPOSE), "--env-file", str(ENV_EX), "config", "-q"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
