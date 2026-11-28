"""TM2-79: Caddy security headers (shared snippet on every site) and the dash CSP.

Static checks parse the Caddyfile through test_pb2_edge.caddy_blocks (which reads test_pb2_edge.CADDYFILE at call
time). The dash CSP is also checked against the paper-bot dashboard: always by scanning paper_bot/web.py source,
and by rendering the page in-process when fastapi/httpx are importable (they are not in the deploy CI env).
`caddy validate` runs in the compose caddy image when a docker daemon is up.
"""
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import test_pb2_edge as pe

DEPLOY = Path(__file__).resolve().parent
PAPER_BOT = DEPLOY.parent / "paper-bot"
WEB_PY = PAPER_BOT / "paper_bot" / "web.py"

SNIPPET = "(security_headers)"
SITES = {"mcp.{$DOMAIN}", "openalgo.{$DOMAIN}", "dash.{$DOMAIN}"}
MCP, OPENALGO, DASH = "mcp.{$DOMAIN}", "openalgo.{$DOMAIN}", "dash.{$DOMAIN}"
DASH_CSP = {
    "default-src": ["'self'"],
    "img-src": ["'self'", "data:"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "script-src": ["'self'"],
    "frame-ancestors": ["'none'"],
}


# --- helpers ---

def caddy_text():
    return pe.CADDYFILE.read_text(encoding="utf-8")


def header_blocks(block):
    """Bodies (list of token lists, comments dropped) of every `header` directive inside a block."""
    out, cur, depth = [], None, 0
    for line in block.splitlines()[1:]:
        s = line.strip()
        if cur is None:
            if re.fullmatch(r"header\s*\{", s):
                cur, depth = [], 1
            elif re.match(r"header\s", s):  # one-line form `header Field value` is its own (defer-less) body
                out.append([shlex.split(s)[1:]])
            continue
        depth += s.count("{") - s.count("}")
        if depth == 0:
            out.append(cur)
            cur = None
        elif s and not s.startswith("#"):
            cur.append(shlex.split(s))
    assert cur is None, "unterminated header block"
    return out


def header_fields(block):
    """{field: [values]} over all header blocks of a block (deleted fields like `-Server` map to [])."""
    fields = {}
    for body in header_blocks(block):
        for toks in body:
            if toks == ["defer"]:
                continue
            fields.setdefault(toks[0], []).extend(toks[1:])
    return fields


def parse_csp(value):
    d = {}
    for part in value.split(";"):
        toks = part.split()
        if toks:
            assert toks[0] not in d, f"duplicate CSP directive {toks[0]}"
            d[toks[0]] = toks[1:]
    return d


def imports(block):
    return re.findall(r"^\s*import\s+(\S+)\s*$", block, re.M)


# --- snippet ---

def test_snippet_exists_once():
    assert len(re.findall(r"^\(security_headers\)\s*\{", caddy_text(), re.M)) == 1
    assert SNIPPET in pe.caddy_blocks()


def test_snippet_headers_exact():
    b = pe.caddy_blocks()[SNIPPET]
    hb = header_blocks(b)
    assert len(hb) == 1
    assert ["defer"] in hb[0], "without defer upstream headers would not be overridden"
    assert header_fields(b) == {
        "Strict-Transport-Security": ["max-age=31536000"],
        "X-Content-Type-Options": ["nosniff"],
        "Referrer-Policy": ["no-referrer"],
        "-Server": [],
    }


def test_hsts_no_preload_or_subdomains():
    text = caddy_text()
    assert not re.search(r"preload", text, re.I), "sslip.io deploys rotate; never preload"
    assert not re.search(r"includeSubDomains", text, re.I)
    for b in pe.caddy_blocks().values():
        for v in header_fields(b).get("Strict-Transport-Security", []):
            assert v == "max-age=31536000"


def test_snippet_has_no_frame_or_csp_headers():
    # The snippet also applies to openalgo, so it must not carry XFO or CSP.
    f = header_fields(pe.caddy_blocks()[SNIPPET])
    assert "X-Frame-Options" not in f and "Content-Security-Policy" not in f


# --- sites ---

def test_site_set_is_exactly_three():
    blocks = pe.caddy_blocks()
    sites = {h for h in blocks if h and not h.startswith("(")}
    assert sites == SITES
    assert {h for h in blocks if h.startswith("(")} == {SNIPPET}


@pytest.mark.parametrize("site", sorted(SITES))
def test_every_site_imports_snippet_once(site):
    b = pe.caddy_blocks()[site]
    assert imports(b) == ["security_headers"]
    # first directive, so nothing earlier in the block can bypass it
    first = next(l.strip() for l in b.splitlines()[1:] if l.strip() and not l.strip().startswith("#"))
    assert first == "import security_headers"


def test_all_derived_sites_import_snippet():
    # Any site added later (derived from the file, not the fixed set) must import the snippet too.
    for h, b in pe.caddy_blocks().items():
        if h and not h.startswith("("):
            assert "security_headers" in imports(b), h


@pytest.mark.parametrize("site", [MCP, DASH])
def test_xfo_deny(site):
    b = pe.caddy_blocks()[site]
    assert header_fields(b)["X-Frame-Options"] == ["DENY"]
    for body in header_blocks(b):
        assert ["defer"] in body


def test_mcp_has_no_csp():
    assert "Content-Security-Policy" not in header_fields(pe.caddy_blocks()[MCP])


def test_openalgo_no_xfo_no_csp():
    b = pe.caddy_blocks()[OPENALGO]
    assert header_blocks(b) == []
    code = "\n".join(l for l in b.splitlines() if not l.strip().startswith("#"))
    assert not re.search(r"X-Frame-Options|Content-Security-Policy|frame-ancestors", code, re.I)


def test_dash_csp_exact():
    vals = header_fields(pe.caddy_blocks()[DASH])["Content-Security-Policy"]
    assert len(vals) == 1
    assert parse_csp(vals[0]) == DASH_CSP


def test_dash_script_src_strict():
    csp = parse_csp(header_fields(pe.caddy_blocks()[DASH])["Content-Security-Policy"][0])
    assert "'unsafe-inline'" not in csp["script-src"]
    assert "'unsafe-eval'" not in csp["script-src"]
    assert "'unsafe-eval'" not in csp["default-src"] and "'unsafe-inline'" not in csp["default-src"]


def test_dash_headers_exact():
    assert header_fields(pe.caddy_blocks()[DASH]).keys() == {"X-Frame-Options", "Content-Security-Policy"}


# --- dashboard compatibility with the dash CSP ---

def assert_csp_safe(html):
    """No inline/external script, no inline handlers, no javascript: URLs, nothing loaded from another origin."""
    low = html.lower()
    assert "<script" not in low, "script-src 'self' blocks inline scripts"
    tags = re.findall(r"<[a-z][^>]*>", low)  # markup only: escaped user text in cells is not an attribute
    assert tags
    for t in tags:
        assert not re.search(r"\son[a-z]+\s*=", t), f"inline event handler (blocked by the CSP): {t}"
        assert "javascript:" not in t, t
        assert not re.search(r"""\b(?:src|href|action)\s*=\s*["']?\s*(?:https?:)?//""", t), f"cross-origin: {t}"
    assert not re.search(r"<(?:iframe|object|embed|link)\b", low)
    assert not re.search(r"""url\(\s*["']?\s*(?:https?:)?//""", low)
    assert not re.search(r"@import", low)
    assert re.search(r"""<meta\s+http-equiv=["']refresh["']\s+content=["']\d+["']""", low), \
        "auto-refresh must be a meta refresh (no JS)"


def test_dashboard_source_is_csp_safe():
    assert_csp_safe(WEB_PY.read_text(encoding="utf-8"))


@pytest.fixture
def paper_bot_modules():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    sys.path.insert(0, str(PAPER_BOT))
    try:
        from paper_bot import db as D
        from paper_bot.config import Config
        from paper_bot.engine import Engine
        from paper_bot import web as W
        yield D, Config, Engine, W
    finally:
        sys.path.remove(str(PAPER_BOT))


def test_rendered_dashboard_is_csp_safe(paper_bot_modules, tmp_path):
    D, Config, Engine, W = paper_bot_modules
    cfg = Config(symbols=("BTCUSD", "ETHUSD"), data_dir=str(tmp_path))
    conn = D.connect(cfg.db_path)
    assert_csp_safe(W.render(conn, cfg))  # empty DB
    e = Engine(cfg, conn, None)
    t = 1_700_000_100.0
    e._open("BTCUSD", "long", 100.0, t)
    e._decision(t, "BTCUSD", 1_700_000_100, 100.0, 101.0, 99.0, "long", "open",
                "<script>alert(1)</script> onclick=x javascript:y")  # hostile text must be escaped
    e.snapshot(t)
    e._close("BTCUSD", 110.0, t + 300)
    e._decision(t + 300, "BTCUSD", 1_700_000_400, 110.0, 109.0, 111.0, "flat", "close", "")
    e.snapshot(t + 300)
    D.set_state(conn, "last_tick", t + 300)
    html = W.render(conn, cfg, now=t + 310)
    assert "<polyline" in html and "&lt;script&gt;" in html
    assert_csp_safe(html)


# --- caddy validate (docker) ---

def _caddy_image():
    return pe.compose()["services"]["caddy"]["image"]


@pytest.mark.skipif(not shutil.which("docker"), reason="docker not installed")
def test_caddy_validate_with_headers():
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        pytest.skip("docker daemon not running")
    r = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{pe.CADDYFILE}:/etc/caddy/Caddyfile:ro",
         "-e", "DOMAIN=example.test", "-e", "ACME_EMAIL=a@example.test",
         "-e", "DASH_USER=admin", "-e", f"DASH_PASSWORD_HASH={pe.default_hash()}",
         _caddy_image(), "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        capture_output=True, text=True, timeout=300,
    )
    assert r.returncode == 0, r.stdout + r.stderr
