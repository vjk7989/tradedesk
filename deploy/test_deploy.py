"""Static checks for the deploy bundle (P4.1). No network, no image builds."""
import fnmatch
import json
import math
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


def test_caddy_mcp_routes_only_mcp_oauth_and_healthz():
    _, blocks = caddy_blocks()
    assert "mcp.{$DOMAIN}" in blocks
    body = blocks["mcp.{$DOMAIN}"]
    m = re.search(r"@(\w+)\s+path\s+([^\n]+)", body)
    assert m, "no path matcher"
    paths = set(m.group(2).split())
    assert paths == {"/mcp", "/mcp/*", "/healthz", "/authorize", "/token", "/register",
                     "/revoke", "/login", "/.well-known/*"}
    for bad in ("/admin", "/mcpx", "/tokenx", "/"):
        assert not any(fnmatch.fnmatchcase(bad, p) for p in paths), bad
    assert re.findall(r"reverse_proxy\s+(\S+)", body) == ["trade-mcp:8787"]
    assert re.search(r"handle\s+@" + m.group(1) + r"\s*\{[^}]*reverse_proxy\s+trade-mcp", body)
    fallback = re.search(r"handle\s*\{([^}]*)\}", body)
    assert fallback and "reverse_proxy" not in fallback.group(1)


def test_trade_mcp_oauth_env(cfg):
    env = svc(cfg, "trade-mcp")["environment"]
    for k in ("OAUTH_ENABLED", "OAUTH_ISSUER_URL", "OAUTH_PASSWORD_HASH", "OAUTH_ALLOWED_REDIRECT_HOSTS"):
        assert k in env, k
    assert env["OAUTH_ENABLED"] == "0"
    assert env["OAUTH_ALLOWED_REDIRECT_HOSTS"] == "chatgpt.com,claude.ai,claude.com"


def test_mcp_token_readonly_passthrough_and_optional(cfg):
    assert "MCP_TOKEN_READONLY: ${MCP_TOKEN_READONLY:-}" in COMPOSE.read_text()
    assert svc(cfg, "trade-mcp")["environment"]["MCP_TOKEN_READONLY"] == ""
    assert env_example()["MCP_TOKEN_READONLY"] == ""


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
    assert len(keys) == 12
    data = json.loads((DEPLOY / "risk.example.json").read_text())
    assert set(data) == set(keys)


def test_risk_example_values_positive():
    data = json.loads((DEPLOY / "risk.example.json").read_text())
    for k, v in data.items():
        if isinstance(v, list):
            assert all(isinstance(x, str) for x in v), k
        elif isinstance(v, dict):
            for ck, cv in v.items():
                assert isinstance(ck, str) and ck.strip() != "", k
                assert isinstance(cv, (int, float)) and not isinstance(cv, bool), k
                assert math.isfinite(cv) and cv > 0, k
        else:
            assert isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0, k
            if k in {"maxQtyPerOrder", "maxOrdersPerDay", "maxOrdersPerRun"}:
                assert isinstance(v, int), k


# --- P5.2 edge tests: Caddy matcher semantics, OAuth defaults, runbook ---
import posixpath  # noqa: E402
import shutil  # noqa: E402

MCP_SITE = "mcp.{$DOMAIN}"
SCRYPT_RE = re.compile(r"^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$")


def caddy_mcp_matcher_paths():
    body = caddy_blocks()[1][MCP_SITE]
    m = re.search(r"@(\w+)\s+path\s+([^\n]+)", body)
    assert m, "no path matcher"
    return m.group(2).split()


def caddy_clean(p):
    """Caddy matches the cleaned URL path (query ignored); `..`/`.` collapse, trailing slash kept."""
    p = p.split("?", 1)[0].split("#", 1)[0] or "/"
    cleaned = posixpath.normpath(p)
    if cleaned.startswith("//"):
        cleaned = "/" + cleaned.lstrip("/")
    if p.endswith("/") and cleaned != "/":
        cleaned += "/"
    return cleaned


def caddy_path_match(pattern, req_path):
    """Caddy v2 `path` matcher: case-insensitive; `/x*` prefix, `*x` suffix,
    `*x*` substring, no `*` exact, else path.Match-style glob."""
    pat, p = pattern.lower(), caddy_clean(req_path).lower()
    stars = pat.count("*")
    if stars == 0:
        return p == pat
    if stars == 1 and pat.endswith("*"):
        return p.startswith(pat[:-1])
    if stars == 1 and pat.startswith("*"):
        return p.endswith(pat[1:])
    if stars == 2 and pat.startswith("*") and pat.endswith("*"):
        return pat[1:-1] in p
    return fnmatch.fnmatchcase(p, pat) and p.count("/") == pat.count("/")


def caddy_mcp_route(req_path):
    hit = any(caddy_path_match(pt, req_path) for pt in caddy_mcp_matcher_paths())
    return "trade-mcp:8787" if hit else 404


@pytest.mark.parametrize("path", [
    "/mcp", "/mcp/", "/mcp/x", "/mcp/x/y", "/healthz",
    "/authorize", "/authorize?x=1",
    "/authorize?response_type=code&redirect_uri=https://claude.ai/cb",
    "/token", "/register", "/revoke", "/login",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
])
def test_caddy_mcp_allowed_paths_route_to_trade_mcp(path):
    assert caddy_mcp_route(path) == "trade-mcp:8787"


@pytest.mark.parametrize("path", [
    "/", "", "?x=/mcp", "/admin", "/mcpx", "/mcp-admin", "/tokenx", "/token/x", "/loginx",
    "/authorize/", "/authorize/x", "/register/../admin",
    "/.well-known", "/.well-knownx/a", "/.well-known/../admin", "/mcp/../admin",
    "/healthz/../admin", "/api/v1/placeorder", "/ws", "/runs",
])
def test_caddy_mcp_other_paths_404(path):
    assert caddy_mcp_route(path) == 404


@pytest.mark.parametrize("path", ["/MCP", "/Mcp/x", "/AUTHORIZE", "/.WELL-KNOWN/oauth-authorization-server"])
def test_caddy_mcp_case_insensitive_only_reaches_trade_mcp(path):
    # Caddy's path matcher is case-insensitive, so these reach trade-mcp (which does
    # its own case-sensitive routing). Safe expectation: the only possible upstream
    # from the mcp site is trade-mcp; nothing else becomes reachable.
    assert caddy_mcp_route(path) == "trade-mcp:8787"


def test_caddy_mcp_matcher_patterns_well_formed():
    paths = caddy_mcp_matcher_paths()
    assert len(paths) == len(set(paths)), "duplicate matcher path"
    for p in paths:
        assert p.startswith("/"), p
        # only trailing-segment wildcards; no '/mcp*'-style prefix that would admit /mcpx
        assert "*" not in p or (p.endswith("/*") and p.count("*") == 1), p
    assert "/*" not in paths and "*" not in paths


def test_caddy_mcp_site_has_no_other_upstreams():
    body = caddy_blocks()[1][MCP_SITE]
    assert "bt-service" not in body and ":8000" not in body
    assert "openalgo" not in body and ":5000" not in body and ":8765" not in body
    assert re.findall(r"reverse_proxy\s+(\S+)", body) == ["trade-mcp:8787"]
    assert "handle_path" not in body and "rewrite" not in body


def test_caddy_openalgo_site_never_proxies_trade_mcp_or_bt():
    body = caddy_blocks()[1]["openalgo.{$DOMAIN}"]
    assert "trade-mcp" not in body and "bt-service" not in body


# --- OAuth / read-only token env defaults ---
def test_compose_oauth_defaults_exact():
    raw = COMPOSE.read_text()
    for line in (
        "MCP_TOKEN_READONLY: ${MCP_TOKEN_READONLY:-}",
        "OAUTH_ENABLED: ${OAUTH_ENABLED:-0}",
        "OAUTH_ISSUER_URL: ${OAUTH_ISSUER_URL:-}",
        "OAUTH_PASSWORD_HASH: ${OAUTH_PASSWORD_HASH:-}",
        "OAUTH_ALLOWED_REDIRECT_HOSTS: ${OAUTH_ALLOWED_REDIRECT_HOSTS:-chatgpt.com,claude.ai,claude.com}",
    ):
        assert line in raw, line
    # optional features must not be required (a :? would break deployments without them)
    assert not re.search(r"\$\{OAUTH_\w+:\?", raw)
    assert not re.search(r"\$\{MCP_TOKEN_READONLY:\?", raw)


MIN_ENV = "MCP_TOKEN=x\nBT_TOKEN=y\nOPENALGO_API_KEY=z\nDOMAIN=example.com\nACME_EMAIL=a@b.c\n"
OPTIONAL_VARS = ("OAUTH_ENABLED", "OAUTH_ISSUER_URL", "OAUTH_PASSWORD_HASH",
                 "OAUTH_ALLOWED_REDIRECT_HOSTS", "MCP_TOKEN_READONLY")


def compose_env_with(env_text, tmp_path, monkeypatch):
    for k in OPTIONAL_VARS:
        monkeypatch.delenv(k, raising=False)
    env_file = tmp_path / "env"
    env_file.write_text(env_text)
    out = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE), "--env-file", str(env_file),
         "config", "--format", "json"],
        capture_output=True, text=True, cwd=str(DEPLOY),
    )
    assert out.returncode == 0, out.stderr
    return svc(json.loads(out.stdout), "trade-mcp")["environment"]


def test_compose_optional_vars_unset_defaults(tmp_path, monkeypatch):
    env = compose_env_with(MIN_ENV, tmp_path, monkeypatch)
    assert env["OAUTH_ENABLED"] == "0"
    assert env["OAUTH_ISSUER_URL"] == ""
    assert env["OAUTH_PASSWORD_HASH"] == ""
    assert env["OAUTH_ALLOWED_REDIRECT_HOSTS"] == "chatgpt.com,claude.ai,claude.com"
    assert env["MCP_TOKEN_READONLY"] == ""


def test_compose_empty_oauth_enabled_falls_back_to_0(tmp_path, monkeypatch):
    env = compose_env_with(MIN_ENV + "OAUTH_ENABLED=\nOAUTH_ALLOWED_REDIRECT_HOSTS=\n", tmp_path, monkeypatch)
    assert env["OAUTH_ENABLED"] == "0"
    assert env["OAUTH_ALLOWED_REDIRECT_HOSTS"] == "chatgpt.com,claude.ai,claude.com"


def test_compose_passes_readonly_token_through(tmp_path, monkeypatch):
    tok = "r" * 32
    env = compose_env_with(MIN_ENV + f"MCP_TOKEN_READONLY={tok}\n", tmp_path, monkeypatch)
    assert env["MCP_TOKEN_READONLY"] == tok


def test_env_example_documents_readonly_token():
    text = ENV_EX.read_text()
    assert re.search(r"^#[^\n]*read-only[^\n]*\n\s*MCP_TOKEN_READONLY=\s*$", text, re.M | re.I)


def test_env_example_oauth_disabled_and_placeholders():
    ex = env_example()
    assert ex["OAUTH_ENABLED"] == "0"
    assert ex["OAUTH_ISSUER_URL"].startswith("https://")
    assert "example" in ex["OAUTH_ISSUER_URL"]
    assert ex["OAUTH_ALLOWED_REDIRECT_HOSTS"] == "chatgpt.com,claude.ai,claude.com"
    h = ex["OAUTH_PASSWORD_HASH"]
    assert not SCRYPT_RE.match(h), "placeholder is a usable scrypt hash"
    assert not re.search(r"[0-9a-f]{32}", h, re.I)
    assert h == "" or PLACEHOLDER.search(h)


def test_env_example_has_generator_command():
    text = ENV_EX.read_text()
    assert "scryptSync" in text and "randomBytes(16)" in text and ",64)" in text


def test_no_real_scrypt_hash_shipped():
    for f in (ENV_EX, ROOT / "docs" / "vps-runbook.md", COMPOSE):
        assert not re.search(r"scrypt:[0-9a-f]{32}:[0-9a-f]{128}", f.read_text(), re.I), f


def test_compose_env_example_oauth_still_off(cfg):
    env = svc(cfg, "trade-mcp")["environment"]
    assert env["OAUTH_ENABLED"] != "1"
    assert not SCRYPT_RE.match(env["OAUTH_PASSWORD_HASH"])


def test_trade_mcp_still_unpublished(cfg):
    s = svc(cfg, "trade-mcp")
    assert not s.get("ports")
    assert not s.get("network_mode")
    assert "8787" not in json.dumps(svc(cfg, "caddy").get("ports", []))
    for name, other in cfg["services"].items():
        for p in other.get("ports", []) or []:
            assert str(p.get("target")) != "8787", name


# --- runbook ---
def runbook_oauth_section():
    text = (ROOT / "docs" / "vps-runbook.md").read_text()
    m = re.search(r"^##[^\n]*OAuth[^\n]*\n.*?(?=^## |\Z)", text, re.M | re.S)
    assert m, "no OAuth section"
    return m.group(0)


def test_runbook_oauth_section():
    sec = runbook_oauth_section()
    assert "ChatGPT" in sec and "claude.ai" in sec
    assert "https://mcp.<DOMAIN>/mcp" in sec
    assert "8787" in sec
    assert re.search(r"never publish|must not be published|never be published", sec, re.I)
    assert "OAUTH_ENABLED=1" in sec
    assert "OAUTH_ISSUER_URL=https://" in sec
    assert "scryptSync" in sec


# --- trade-mcp level: empty values are treated as unset ---
def test_trade_mcp_config_treats_empty_readonly_as_unset_static():
    # zod is not installed in this checkout, so config.ts cannot be imported here; static check.
    src = (ROOT / "trade-mcp" / "src" / "config.ts").read_text()
    assert re.search(r"MCP_TOKEN_READONLY\?\.trim\(\)\s*\?[^:]+:\s*undefined", src)


def test_trade_mcp_oauth_config_static():
    src = (ROOT / "trade-mcp" / "src" / "oauth" / "config.ts").read_text()
    assert re.search(r'OAUTH_ENABLED\s*!==\s*"1"\)\s*return undefined', src)
    assert SCRYPT_RE.pattern in src  # same hash format as guarded above


NODE_OAUTH = r"""
import(process.argv[1]).then((m) => {
  const cases = JSON.parse(process.argv[2]);
  const out = cases.map((env) => {
    try { return m.loadOAuthConfig(env) === undefined ? "off" : "on"; } catch (e) { return "err"; }
  });
  console.log(JSON.stringify(out));
});
"""


def test_trade_mcp_oauth_config_runtime_defaults():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    mod = (ROOT / "trade-mcp" / "src" / "oauth" / "config.ts").as_uri()
    ex = env_example()
    cases = [
        {"OAUTH_ENABLED": "0", "OAUTH_ISSUER_URL": "", "OAUTH_PASSWORD_HASH": ""},  # compose default
        {},  # nothing set
        {k: ex[k] for k in ("OAUTH_ENABLED", "OAUTH_ISSUER_URL", "OAUTH_PASSWORD_HASH")},  # as shipped
        # enabling with the shipped placeholder hash must be rejected, not accepted
        {"OAUTH_ENABLED": "1", "OAUTH_ISSUER_URL": ex["OAUTH_ISSUER_URL"],
         "OAUTH_PASSWORD_HASH": ex["OAUTH_PASSWORD_HASH"]},
    ]
    r = subprocess.run([node, "--input-type=module", "-e", NODE_OAUTH, "--", mod, json.dumps(cases)],
                       capture_output=True, text=True)
    if r.returncode != 0 and ("Unknown file extension" in r.stderr or "strip-types" in r.stderr):
        pytest.skip("node cannot import .ts directly")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout.strip().splitlines()[-1]) == ["off", "off", "off", "err"]
