"""Static checks for the deploy bundle (P4.1). No network, no image builds."""
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy"
COMPOSE = DEPLOY / "docker-compose.yml"
ENV_EX = DEPLOY / ".env.example"
SERVICES = {"openalgo", "trade-mcp", "bt-service", "caddy"}


@pytest.fixture(scope="module")
def cfg():
    out = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE), "--env-file", str(ENV_EX),
         "config", "--format", "json"],
        capture_output=True, text=True, cwd=str(DEPLOY),
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def svc(cfg, name):
    return cfg["services"][name]


def net_keys(cfg, name):
    n = svc(cfg, name).get("networks") or {}
    return set(n.keys() if isinstance(n, dict) else n)


# --- services / ports ---
def test_services_exact(cfg):
    assert set(cfg["services"]) == SERVICES


def test_only_caddy_publishes_80_443(cfg):
    ports = svc(cfg, "caddy").get("ports", [])
    published = sorted(str(p.get("published")) for p in ports)
    assert published == ["443", "80"]
    for p in ports:
        assert str(p["target"]) in {"80", "443"}


@pytest.mark.parametrize("name", ["openalgo", "trade-mcp", "bt-service"])
def test_backends_publish_nothing(cfg, name):
    assert not svc(cfg, name).get("ports")


# --- networks ---
def test_internal_network_is_internal(cfg):
    assert cfg["networks"]["internal"].get("internal") is True
    for n in ("egress", "public"):
        assert not cfg["networks"][n].get("internal")


def test_trade_mcp_internal_only(cfg):
    assert net_keys(cfg, "trade-mcp") == {"internal"}


@pytest.mark.parametrize("name", ["openalgo", "bt-service"])
def test_internal_plus_egress(cfg, name):
    assert net_keys(cfg, name) == {"internal", "egress"}


def test_caddy_internal_plus_public(cfg):
    assert net_keys(cfg, "caddy") == {"internal", "public"}


# --- restart / healthchecks ---
@pytest.mark.parametrize("name", sorted(SERVICES))
def test_restart_unless_stopped(cfg, name):
    assert svc(cfg, name).get("restart") == "unless-stopped"


@pytest.mark.parametrize("name", ["trade-mcp", "bt-service"])
def test_healthchecks(cfg, name):
    hc = svc(cfg, name).get("healthcheck")
    assert hc and hc.get("test") and not hc.get("disable")
    assert any("healthz" in str(t) for t in hc["test"])


# --- trade-mcp env and mounts ---
def test_trade_mcp_risk_mount_readonly(cfg):
    vols = svc(cfg, "trade-mcp").get("volumes", [])
    risk = [v for v in vols if v.get("target") == "/config/risk.json"]
    assert len(risk) == 1 and risk[0].get("read_only") is True
    assert svc(cfg, "trade-mcp")["environment"]["RISK_CONFIG"] == "/config/risk.json"


def test_trade_mcp_env(cfg):
    env = svc(cfg, "trade-mcp")["environment"]
    assert env["MODE"] == "paper"
    assert env["HOST"] == "0.0.0.0"
    assert env["OPENALGO_URL"] == "http://openalgo:5000"
    assert env["BT_URL"] == "http://bt-service:8000"


def test_mode_defaults_to_paper_when_unset():
    raw = COMPOSE.read_text()
    assert re.search(r"MODE:\s*\$\{MODE:-paper\}", raw)


# --- bt-service limits ---
def test_bt_service_limits(cfg):
    s = svc(cfg, "bt-service")
    limits = s.get("deploy", {}).get("resources", {}).get("limits", {})
    mem = s.get("mem_limit") or limits.get("memory")
    mem = int(mem) if str(mem).isdigit() else mem
    assert isinstance(mem, int), mem
    assert 0.9 * 2**30 <= mem <= 1.1 * 2**30
    cpus = s.get("cpus") or limits.get("cpus")
    assert float(cpus) == 1.0
    tmpfs = s.get("tmpfs") or []
    tmpfs = [tmpfs] if isinstance(tmpfs, str) else tmpfs
    assert any(t.split(":")[0] == "/runs" for t in tmpfs)


# --- Dockerfiles ---
DOCKERFILES = [ROOT / "trade-mcp" / "Dockerfile", ROOT / "bt-service" / "Dockerfile"]


@pytest.mark.parametrize("df", DOCKERFILES, ids=lambda p: p.parent.name)
def test_dockerfile_non_root(df):
    users = re.findall(r"^\s*USER\s+(\S+)", df.read_text(), re.M)
    assert users, "no USER directive"
    assert users[-1] not in {"root", "0", "0:0"}


@pytest.mark.parametrize("df", DOCKERFILES, ids=lambda p: p.parent.name)
def test_base_images_pinned(df):
    text = df.read_text()
    refs = re.findall(r"^\s*FROM\s+(?:--\S+\s+)?(\S+)", text, re.M)
    refs += re.findall(r"COPY\s+--from=(\S+)", text)
    stages = set(re.findall(r"^\s*FROM\s+\S+\s+AS\s+(\S+)", text, re.M | re.I))
    for ref in refs:
        if ref in stages:
            continue
        assert ":" in ref.split("/")[-1] or "@sha256:" in ref, ref
        assert not ref.endswith(":latest"), ref


def test_trade_mcp_builds_with_tsconfig_build():
    text = (ROOT / "trade-mcp" / "Dockerfile").read_text()
    assert re.search(r"tsc\s+-p\s+tsconfig\.build\.json", text)
    assert (ROOT / "trade-mcp" / "tsconfig.build.json").is_file()


def test_uv_pinned():
    text = (ROOT / "bt-service" / "Dockerfile").read_text()
    assert "ghcr.io/astral-sh/uv:0.9.26" in text


@pytest.mark.parametrize("path,needles", [
    (ROOT / "trade-mcp" / ".dockerignore", ["node_modules", ".env"]),
    (ROOT / "bt-service" / ".dockerignore", [".venv", ".env"]),
], ids=["trade-mcp", "bt-service"])
def test_dockerignore(path, needles):
    lines = {ln.strip().rstrip("/") for ln in path.read_text().splitlines()}
    for n in needles:
        assert n in lines or f"{n}*" in lines, n


# --- .env.example ---
def env_example():
    out = {}
    for line in ENV_EX.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


SECRET_KEYS = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|PEPPER", re.I)
PLACEHOLDER = re.compile(r"change-?me|replace|^<.*>$|example", re.I)


def test_env_example_secrets_are_placeholders():
    for k, v in env_example().items():
        if SECRET_KEYS.search(k):
            assert v == "" or PLACEHOLDER.search(v), f"{k}={v}"


def test_env_example_no_real_looking_values():
    for k, v in env_example().items():
        if PLACEHOLDER.search(v):
            continue
        assert not re.fullmatch(r"[A-Fa-f0-9]{16,}", v), k
        assert not re.fullmatch(r"[A-Za-z0-9_+/=]{24,}", v), k
        assert not v.startswith(("sk-", "ghp_", "xox")), k


def test_every_compose_var_in_env_example():
    used = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)", COMPOSE.read_text()))
    missing = used - set(env_example())
    assert not missing, missing


# --- Caddyfile ---
def caddy_blocks():
    text = (DEPLOY / "Caddyfile").read_text()
    blocks = {}
    for m in re.finditer(r"^(\S[^\n]*?)\s+\{[ \t]*$", text, re.M):
        depth, j = 1, m.end()
        while depth and j < len(text):
            depth += {"{": 1, "}": -1}.get(text[j], 0)
            j += 1
        blocks[m.group(1).strip()] = text[m.end():j]
    return text, blocks


def test_caddy_mcp_routes_only_mcp_and_healthz():
    _, blocks = caddy_blocks()
    assert "mcp.{$DOMAIN}" in blocks
    body = blocks["mcp.{$DOMAIN}"]
    m = re.search(r"@(\w+)\s+path\s+([^\n]+)", body)
    assert m, "no path matcher"
    paths = set(m.group(2).split())
    assert paths <= {"/mcp", "/mcp/*", "/mcp*", "/healthz"}
    assert "/healthz" in paths and paths & {"/mcp", "/mcp*", "/mcp/*"}
    assert re.findall(r"reverse_proxy\s+(\S+)", body) == ["trade-mcp:8787"]
    assert re.search(r"handle\s+@" + m.group(1) + r"\s*\{[^}]*reverse_proxy\s+trade-mcp", body)
    fallback = re.search(r"handle\s*\{([^}]*)\}", body)
    assert fallback and "reverse_proxy" not in fallback.group(1)


def test_nothing_routes_to_bt_service():
    text, _ = caddy_blocks()
    assert "bt-service" not in text
    assert ":8000" not in text


# --- risk.example.json ---
def risk_keys_from_config_ts():
    src = (ROOT / "trade-mcp" / "src" / "config.ts").read_text()
    body = re.search(r"riskSchema\s*=\s*z\s*\.object\(\{(.*?)\}\)", src, re.S).group(1)
    return re.findall(r"^\s*(\w+)\s*:", body, re.M)


def test_risk_example_keys_match_schema():
    keys = risk_keys_from_config_ts()
    assert len(keys) == 11
    data = json.loads((DEPLOY / "risk.example.json").read_text())
    assert set(data) == set(keys)


def test_risk_example_values_positive():
    data = json.loads((DEPLOY / "risk.example.json").read_text())
    for k, v in data.items():
        if isinstance(v, list):
            assert all(isinstance(x, str) for x in v), k
        else:
            assert isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0, k
            if k in {"maxQtyPerOrder", "maxOrdersPerDay", "maxOrdersPerRun"}:
                assert isinstance(v, int), k
