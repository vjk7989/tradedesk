"""PB-2 edge tests: paper-bot compose wiring, dash Caddy site (fail-closed basic auth), env example, CI job.

Static checks need only pyyaml; bcrypt checks skip without `bcrypt`; docker checks skip without docker
(compose config needs only the CLI; caddy validate needs a running daemon).
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parent
ROOT = DEPLOY.parent
COMPOSE = DEPLOY / "docker-compose.yml"
CADDYFILE = DEPLOY / "Caddyfile"
ENV_EX = DEPLOY / ".env.example"
CI = ROOT / ".github" / "workflows" / "ci.yml"

STRATEGY_DEFAULTS = {
    "SYMBOLS": "BTCUSD",
    "RESOLUTION": "5m",
    "INTERVAL_SEC": "60",
    "FAST": "9",
    "SLOW": "21",
    "ALLOW_SHORT": "0",
    "NOTIONAL_USD": "1000",
    "START_CAPITAL_USD": "10000",
    "TAKER_FEE": "0.0005",
    "SLIPPAGE": "0.0002",
    "DELTA_BASE_URL": "https://api.india.delta.exchange",
}

# Fixed snapshot of the pre-PB-2 site blocks (main @ efe8a39). Must not drift.
MCP_SNAPSHOT = """mcp.{$DOMAIN} {
	@allowed path /mcp /mcp/* /healthz /authorize /token /register /revoke /login /.well-known/*
	handle @allowed {
		reverse_proxy trade-mcp:8787 {
			flush_interval -1
		}
	}
	handle {
		respond "not found" 404
	}
}"""

OPENALGO_SNAPSHOT = """openalgo.{$DOMAIN} {
	# OpenAlgo WebSocket proxy (WEBSOCKET_URL=wss://openalgo.<domain>/ws; prefix stripped)
	handle_path /ws* {
		reverse_proxy openalgo:8765
	}
	handle {
		reverse_proxy openalgo:5000
	}
}"""

BCRYPT_RE = re.compile(r"^\$(2a|2b|2y)\$(\d{2})\$[./A-Za-z0-9]{53}$")


# --- helpers ---

def compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def pb():
    return compose()["services"]["paper-bot"]


def caddy_blocks():
    """Top-level Caddyfile blocks keyed by header (text before the opening brace; global block is "")."""
    lines = CADDYFILE.read_text(encoding="utf-8").splitlines()
    blocks, depth, cur, header = {}, 0, [], None
    for line in lines:
        if depth == 0 and line.rstrip().endswith("{"):
            header, cur = line.rstrip()[:-1].strip(), []
        if header is not None:
            cur.append(line)
        depth += line.count("{") - line.count("}")
        if header is not None and depth == 0:
            blocks[header] = "\n".join(cur)
            header = None
    return blocks


def unescape_config(v):
    """`docker compose config` re-escapes $ as $$ in its output; undo that to get the runtime value."""
    return v.replace("$$", "$")


def default_hash():
    raw = compose()["services"]["caddy"]["environment"]["DASH_PASSWORD_HASH"]
    m = re.fullmatch(r"\$\{DASH_PASSWORD_HASH:-(.+)\}", raw)
    assert m, f"DASH_PASSWORD_HASH must be ${{VAR:-default}}, got {raw!r}"
    return m.group(1).replace("$$", "$")  # compose escapes $ as $$


def env_example():
    out = {}
    for line in ENV_EX.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


# --- compose: paper-bot service ---

def test_paper_bot_publishes_no_ports():
    assert "ports" not in pb()


def test_paper_bot_only_internal_network():
    nets = pb()["networks"]
    names = set(nets.keys() if isinstance(nets, dict) else nets)
    assert names == {"internal"}
    assert "network_mode" not in pb()


def test_internal_network_is_not_public():
    # paper-bot must never share the 'public' network the way caddy does.
    assert "public" not in str(pb()["networks"])


def test_mem_limit_equals_memswap_limit():
    s = pb()
    assert s["mem_limit"] == s["memswap_limit"] == "${PAPER_BOT_MEM_LIMIT:-256m}"


def test_healthcheck_python_urllib_on_healthz():
    hc = pb()["healthcheck"]
    test = hc["test"]
    assert isinstance(test, list) and test[0] == "CMD", "exec form, no shell needed"
    assert test[1] == "python"
    cmd = " ".join(test)
    assert "urllib.request" in cmd
    assert "/healthz" in cmd and ":8090" in cmd
    assert "curl" not in cmd and "wget" not in cmd  # slim image has neither
    for k in ("interval", "timeout", "retries"):
        assert k in hc


def test_healthcheck_fails_on_non_200_and_has_timeout():
    cmd = " ".join(pb()["healthcheck"]["test"])
    assert "timeout=" in cmd
    assert "sys.exit" in cmd


def test_data_volume_mounted_at_data():
    vols = pb()["volumes"]
    targets = [v.split(":")[1] if isinstance(v, str) else v["target"] for v in vols]
    assert "/data" in targets
    assert "paper_bot_data:/data" in vols
    assert "paper_bot_data" in compose()["volumes"]


def test_restart_unless_stopped():
    assert pb()["restart"] == "unless-stopped"


def test_build_context_is_paper_bot_dir():
    b = pb()["build"]
    ctx = b["context"] if isinstance(b, dict) else b
    assert ctx.replace("\\", "/").rstrip("/") == "../paper-bot"


@pytest.mark.parametrize("var,default", sorted(STRATEGY_DEFAULTS.items()))
def test_strategy_env_var_has_default(var, default):
    env = pb()["environment"]
    assert env[var] == "${%s:-%s}" % (var, default)


def test_no_strategy_env_var_is_required_or_bare():
    for k, v in pb()["environment"].items():
        assert ":?" not in str(v), f"{k} must not be required"
        assert re.fullmatch(r"\$\{%s:-[^}]+\}" % k, str(v)), f"{k} lacks a non-empty default: {v!r}"


def test_paper_bot_env_has_no_secrets():
    env = pb()["environment"]
    assert not any(re.search(r"KEY|SECRET|TOKEN|PASSWORD", k) for k in env)


def test_caddy_depends_on_paper_bot_and_gets_dash_vars():
    c = compose()["services"]["caddy"]
    dep = c["depends_on"]
    assert "paper-bot" in (dep.keys() if isinstance(dep, dict) else dep)
    env = c["environment"]
    assert env["DASH_USER"] == "${DASH_USER:-admin}"
    assert ":?" not in env["DASH_PASSWORD_HASH"]  # fail closed, not fail to start


def test_no_other_service_gets_dash_credentials():
    for name, s in compose()["services"].items():
        if name == "caddy":
            continue
        env = s.get("environment") or {}
        keys = env.keys() if isinstance(env, dict) else [e.split("=")[0] for e in env]
        assert "DASH_PASSWORD_HASH" not in keys, name


# --- Caddyfile ---

def test_dash_site_exists_once():
    text = CADDYFILE.read_text(encoding="utf-8")
    assert len(re.findall(r"^dash\.\{\$DOMAIN\}\s*\{", text, re.M)) == 1


def test_dash_basic_auth_before_reverse_proxy():
    b = caddy_blocks()["dash.{$DOMAIN}"]
    assert "basicauth" not in b  # deprecated name in Caddy >= 2.8
    ia = b.index("basic_auth")
    ip = b.index("reverse_proxy paper-bot:8090")
    assert ia < ip
    assert "{$DASH_USER} {$DASH_PASSWORD_HASH}" in b[ia:ip]


def test_dash_basic_auth_not_scoped_by_matcher():
    # basic_auth must guard every path: no matcher token between directive and '{'.
    b = caddy_blocks()["dash.{$DOMAIN}"]
    assert re.search(r"^\s*basic_auth\s*\{", b, re.M)
    assert "handle" not in b and "@" not in b


def test_dash_proxies_only_to_paper_bot():
    b = caddy_blocks()["dash.{$DOMAIN}"]
    assert re.findall(r"reverse_proxy\s+(\S+)", b) == ["paper-bot:8090"]


def test_no_other_site_proxies_to_paper_bot():
    for header, b in caddy_blocks().items():
        if header != "dash.{$DOMAIN}":
            assert "paper-bot" not in b, header


def test_mcp_site_unchanged():
    assert caddy_blocks()["mcp.{$DOMAIN}"] == MCP_SNAPSHOT


def test_openalgo_site_unchanged():
    assert caddy_blocks()["openalgo.{$DOMAIN}"] == OPENALGO_SNAPSHOT


def test_site_set_exact():
    assert set(caddy_blocks()) == {"", "mcp.{$DOMAIN}", "openalgo.{$DOMAIN}", "dash.{$DOMAIN}"}


# --- default bcrypt hash (fail-closed) ---

def test_default_hash_is_valid_bcrypt():
    h = default_hash()
    assert len(h) == 60
    m = BCRYPT_RE.fullmatch(h)
    assert m, h
    assert int(m.group(2)) >= 10


def test_default_hash_literal_escapes_every_dollar():
    # Compose interpolates $; a bare $ in the default would be eaten or rejected.
    text = COMPOSE.read_text(encoding="utf-8")
    m = re.search(r"DASH_PASSWORD_HASH:\s*\$\{DASH_PASSWORD_HASH:-([^}]*)\}", text)
    assert m, "default literal not found"
    lit = m.group(1)
    assert "$" in lit
    assert re.fullmatch(r"(?:\$\$|[^$])+", lit), f"unescaped $ in {lit!r}"
    assert lit.count("$$") == 3  # $2b$12$... has exactly three $


def test_default_hash_not_in_env_example():
    # The example must not ship the fallback as a usable value.
    assert env_example().get("DASH_PASSWORD_HASH", "") != default_hash()


@pytest.mark.parametrize("candidate", ["", "admin", "password", "changeme", "Admin", "admin123", "secret"])
def test_default_hash_matches_no_common_password(candidate):
    bcrypt = pytest.importorskip("bcrypt")
    assert not bcrypt.checkpw(candidate.encode(), default_hash().encode())


def test_default_hash_does_not_match_dash_user_default():
    bcrypt = pytest.importorskip("bcrypt")
    user = re.fullmatch(r"\$\{DASH_USER:-(.+)\}", compose()["services"]["caddy"]["environment"]["DASH_USER"]).group(1)
    assert not bcrypt.checkpw(user.encode(), default_hash().encode())


# --- .env.example ---

def test_env_example_hash_blank_or_placeholder():
    v = env_example()["DASH_PASSWORD_HASH"].strip("'\"")
    assert v == "" or not BCRYPT_RE.fullmatch(v), "example must not ship a real hash"


def test_env_example_has_generate_command_comment():
    comments = [l for l in ENV_EX.read_text(encoding="utf-8").splitlines() if l.lstrip().startswith("#")]
    assert any("caddy hash-password" in l and "--plaintext" in l for l in comments)


def test_env_example_generate_command_uses_compose_caddy_image():
    image = compose()["services"]["caddy"]["image"]
    text = ENV_EX.read_text(encoding="utf-8")
    assert f"docker run --rm {image} caddy hash-password" in text


def test_env_example_tells_operator_to_single_quote_value():
    lines = ENV_EX.read_text(encoding="utf-8").splitlines()
    idx = next(i for i, l in enumerate(lines) if l.startswith("DASH_PASSWORD_HASH="))
    comments = [l for l in lines[max(0, idx - 6):idx] if l.lstrip().startswith("#")]
    hint = [l for l in comments if re.search(r"single[- ]?quot", l, re.I)]
    assert hint, "no single-quote instruction above DASH_PASSWORD_HASH"
    # The instruction must apply to this file, not only to the shell.
    assert any("DASH_PASSWORD_HASH='" in l or ("shell" not in l.lower()) for l in hint), hint
    assert not any("exactly as printed" in l for l in comments), "contradicts the quoting instruction"


@pytest.mark.parametrize("var,default", sorted(STRATEGY_DEFAULTS.items()))
def test_env_example_strategy_values_match_compose_defaults(var, default):
    assert env_example()[var] == default


# --- CI ---

def ci():
    return yaml.safe_load(CI.read_text(encoding="utf-8"))


def _pins(job):
    return {s["uses"].split("@")[0]: s["uses"].split("@")[1] for s in job["steps"] if "uses" in s}


def test_ci_paper_bot_job_uses_same_pins():
    jobs = ci()["jobs"]
    mine = _pins(jobs["paper-bot"])
    assert set(mine) == {"actions/checkout", "astral-sh/setup-uv"}
    for name, job in jobs.items():
        for action, sha in _pins(job).items():
            if action in mine:
                assert mine[action] == sha, f"{action} pin differs from job {name}"
    for sha in mine.values():
        assert re.fullmatch(r"[0-9a-f]{40}", sha), sha


def test_ci_paper_bot_permissions_contents_read():
    wf = ci()
    assert wf["permissions"] == {"contents": "read"}
    job_perm = wf["jobs"]["paper-bot"].get("permissions", {"contents": "read"})
    assert job_perm == {"contents": "read"}
    assert "write" not in CI.read_text(encoding="utf-8")


def test_ci_paper_bot_uv_sync_frozen_and_pytest():
    job = ci()["jobs"]["paper-bot"]
    assert job["defaults"]["run"]["working-directory"] == "paper-bot"
    runs = [s["run"] for s in job["steps"] if "run" in s]
    assert "uv sync --frozen" in runs
    assert "uv sync" not in runs  # never the unfrozen form
    assert runs[-1] == "uv run pytest -q"
    assert runs.index("uv sync --frozen") < runs.index("uv run pytest -q")
    setup = [s for s in job["steps"] if s.get("uses", "").startswith("astral-sh/setup-uv@")][0]
    assert str(setup["with"]["python-version"]) == "3.12"


def test_ci_deploy_builds_paper_bot_image():
    runs = [s.get("run", "") for s in ci()["jobs"]["deploy"]["steps"]]
    build = [r for r in runs if "build paper-bot" in r]
    assert len(build) == 1 and "--env-file deploy/.env.example" in build[0]
    assert runs.index(build[0]) < [i for i, r in enumerate(runs) if "pytest" in r][0]


# --- docker ---

HAS_DOCKER = shutil.which("docker") is not None


def _daemon_up():
    if not HAS_DOCKER:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.mark.skipif(not HAS_DOCKER, reason="no docker")
def test_compose_config_resolves_paper_bot_defaults():
    r = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE), "--env-file", str(ENV_EX), "config", "--format", "json"],
        capture_output=True, text=True, cwd=str(DEPLOY),
    )
    assert r.returncode == 0, r.stderr
    cfg = json.loads(r.stdout)
    s = cfg["services"]["paper-bot"]
    assert s["environment"] == STRATEGY_DEFAULTS
    assert not s.get("ports")
    assert set(s["networks"]) == {"internal"}
    assert s["mem_limit"] == s["memswap_limit"]
    caddy_env = cfg["services"]["caddy"]["environment"]
    assert caddy_env["DASH_USER"] == "admin"
    # .env.example leaves the hash blank -> ":-" falls back to the locked default.
    h = unescape_config(caddy_env["DASH_PASSWORD_HASH"])
    assert h == default_hash()
    assert len(h) == 60 and h.startswith("$2"), h


SAMPLE_HASH = "$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG"


def _resolve_dash_hash(tmp_path, line):
    base = [l for l in ENV_EX.read_text(encoding="utf-8").splitlines() if not l.startswith("DASH_PASSWORD_HASH=")]
    env = tmp_path / ".env"
    env.write_text("\n".join(base + [line]) + "\n", encoding="utf-8")
    r = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE), "--env-file", str(env), "config", "--format", "json"],
        capture_output=True, text=True, cwd=str(DEPLOY),
    )
    if r.returncode != 0:
        return r, None
    return r, unescape_config(json.loads(r.stdout)["services"]["caddy"]["environment"]["DASH_PASSWORD_HASH"])


@pytest.mark.skipif(not HAS_DOCKER, reason="no docker")
def test_single_quoted_hash_in_env_file_resolves_unchanged(tmp_path):
    r, got = _resolve_dash_hash(tmp_path, f"DASH_PASSWORD_HASH='{SAMPLE_HASH}'")
    assert r.returncode == 0, r.stderr
    assert got == SAMPLE_HASH


@pytest.mark.skipif(not HAS_DOCKER, reason="no docker")
def test_unquoted_hash_in_env_file_gets_corrupted(tmp_path):
    # Documents why the operator must single-quote: compose interpolates $ in unquoted .env values.
    r, got = _resolve_dash_hash(tmp_path, f"DASH_PASSWORD_HASH={SAMPLE_HASH}")
    assert r.returncode != 0 or got != SAMPLE_HASH, "unquoted value survived; quoting advice may be stale"


@pytest.mark.skipif(not HAS_DOCKER, reason="no docker")
def test_compose_config_without_dash_vars_still_resolves(tmp_path):
    base = [l for l in ENV_EX.read_text(encoding="utf-8").splitlines() if not l.startswith("DASH_")]
    env = tmp_path / ".env"
    env.write_text("\n".join(base) + "\n", encoding="utf-8")
    r = subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE), "--env-file", str(env), "config", "--format", "json"],
        capture_output=True, text=True, cwd=str(DEPLOY),
    )
    assert r.returncode == 0, r.stderr
    caddy_env = json.loads(r.stdout)["services"]["caddy"]["environment"]
    assert caddy_env["DASH_USER"] == "admin"
    assert unescape_config(caddy_env["DASH_PASSWORD_HASH"]) == default_hash()


@pytest.mark.skipif(not _daemon_up(), reason="docker daemon not running")
def test_caddy_validate_with_default_hash():
    r = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{CADDYFILE}:/etc/caddy/Caddyfile:ro",
         "-e", "DOMAIN=example.test", "-e", "ACME_EMAIL=a@example.test",
         "-e", "DASH_USER=admin", "-e", f"DASH_PASSWORD_HASH={default_hash()}",
         "caddy:2-alpine", "caddy", "validate", "--config", "/etc/caddy/Caddyfile"],
        capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stdout + r.stderr
