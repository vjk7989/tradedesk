import json
import threading

import pytest
from fastapi.testclient import TestClient

from bt_service import app as app_mod

TOKEN = "s3cr3t-" + "t" * 25
HDR = {"Authorization": f"Bearer {TOKEN}"}
BODY = {"code": "x", "symbols": ["A"], "start": "2024-01-01", "end": "2024-02-01"}
API_KEY = "openalgo-key-should-never-leak-123"
MIB = 1024 * 1024
JSON_HDR = {**HDR, "Content-Type": "application/json"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BT_TOKEN", TOKEN)
    monkeypatch.setenv("OPENALGO_API_KEY", API_KEY)
    monkeypatch.setenv("BT_TIMEOUT_S", "77")
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    monkeypatch.setattr(app_mod, "BUSY_WAIT_S", 0.3)
    calls = []

    def fake(**kw):
        calls.append(kw)
        return {"ok": True, "metrics": {}, "equity": [], "trades": [], "warnings": []}

    monkeypatch.setattr(app_mod, "run_backtest", fake)
    with TestClient(app_mod.app, raise_server_exceptions=False) as c:
        c.calls = calls
        yield c


def _no_secrets(r):
    assert TOKEN not in r.text and API_KEY not in r.text
    assert all(TOKEN not in v and API_KEY not in v for v in r.headers.values())


# ---- auth ----

@pytest.mark.parametrize("auth", [
    f"bearer {TOKEN}", f"Bearer  {TOKEN}", f"Bearer {TOKEN}\n".rstrip("\n") + " ", f" Bearer {TOKEN}",
    f"Bearer {TOKEN[:-1]}", f"Bearer {TOKEN}x", "Bearer ", "Bearer", f"Basic {TOKEN}", TOKEN,
])
def test_token_variants_rejected(client, auth):
    r = client.post("/backtest", json=BODY, headers={"Authorization": auth})
    assert r.status_code == 401 and client.calls == []
    _no_secrets(r)


def test_token_with_newline_rejected(client):
    # httpx refuses raw newlines in headers; build ASGI-level check via require_auth directly
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as e:
        app_mod.require_auth(f"Bearer {TOKEN}\n")
    assert e.value.status_code == 401


def test_token_in_body_or_query_not_accepted(client):
    r = client.post("/backtest", json={**BODY, "token": TOKEN})
    assert r.status_code in (401, 422) and client.calls == []
    r = client.post(f"/backtest?token={TOKEN}&access_token={TOKEN}", json=BODY)
    assert r.status_code == 401 and client.calls == []


@pytest.mark.parametrize("n,expected", [(23, 503), (24, 200)])
def test_token_length_boundary(client, monkeypatch, n, expected):
    tok = "k" * n
    monkeypatch.setenv("BT_TOKEN", tok)
    r = client.post("/backtest", json=BODY, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == expected
    if expected == 503:
        assert "BT_TOKEN not configured" in r.text


def test_empty_token_env_and_empty_bearer_is_503_not_200(client, monkeypatch):
    monkeypatch.setenv("BT_TOKEN", "")
    r = client.post("/backtest", json=BODY, headers={"Authorization": "Bearer "})
    assert r.status_code == 503 and client.calls == []


def test_token_rotation_honoured(client, monkeypatch):
    assert client.post("/backtest", json=BODY, headers=HDR).status_code == 200
    new = "n" * 30
    monkeypatch.setenv("BT_TOKEN", new)
    assert client.post("/backtest", json=BODY, headers=HDR).status_code == 401
    assert client.post("/backtest", json=BODY, headers={"Authorization": f"Bearer {new}"}).status_code == 200


def test_healthz_leaks_nothing(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"ok": True}
    _no_secrets(r)


# ---- body size ----

def _padded(size):
    base = json.dumps({**BODY, "code": ""})
    pad = size - len(base)
    body = json.dumps({**BODY, "code": "y" * pad}).encode()
    assert len(body) == size
    return body


def test_exactly_1mib_accepted(client):
    r = client.post("/backtest", content=_padded(MIB), headers=JSON_HDR)
    assert r.status_code == 200 and len(client.calls[0]["code"]) > 0


def test_1mib_plus_one_rejected(client):
    r = client.post("/backtest", content=_padded(MIB + 1), headers=JSON_HDR)
    assert r.status_code == 413 and client.calls == []


def test_lying_content_length_still_capped(client):
    body = _padded(MIB + 100)
    r = client.post("/backtest", content=body, headers={**JSON_HDR, "Content-Length": "10"})
    assert r.status_code in (400, 413) and client.calls == []


def test_streamed_oversize_small_chunks(client):
    def gen():
        for _ in range(MIB // 4096 + 2):
            yield b" " * 4096

    r = client.post("/backtest", content=gen(), headers=JSON_HDR)
    assert r.status_code == 413 and client.calls == []


def test_nested_huge_costs_dict_rejected(client):
    body = json.dumps({**BODY, "costs": {f"k{i}": {"v": "z" * 100} for i in range(20000)}}).encode()
    assert len(body) > MIB
    r = client.post("/backtest", content=body, headers=JSON_HDR)
    assert r.status_code == 413 and client.calls == []


@pytest.mark.parametrize("content", [b"not json", b"[1,2,3]", json.dumps([BODY]).encode(), b""])
def test_non_object_body_422(client, content):
    r = client.post("/backtest", content=content, headers=JSON_HDR)
    assert r.status_code == 422 and client.calls == []


# ---- field types ----

def test_symbols_as_string_rejected(client):
    r = client.post("/backtest", json={**BODY, "symbols": "A"}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


def test_capital_string_number(client):
    # pydantic lax mode coerces "1e6" -> 1e6; behaviour reported, not a security issue
    r = client.post("/backtest", json={**BODY, "capital": "1e6"}, headers=HDR)
    assert r.status_code in (200, 422)
    if r.status_code == 200:
        assert client.calls[0]["capital"] == 1e6


@pytest.mark.parametrize("val", ["NaN", "Infinity", "-Infinity"])
def test_capital_nan_inf_rejected(client, val):
    raw = json.dumps(BODY)[:-1] + f', "capital": {val}}}'
    r = client.post("/backtest", content=raw.encode(), headers=JSON_HDR)
    assert r.status_code == 422 and client.calls == []


@pytest.mark.parametrize("field,val", [("start", "yesterday"), ("end", "01/02/2024")])
def test_non_iso_dates_rejected(client, field, val):
    r = client.post("/backtest", json={**BODY, field: val}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


def test_iso_date_accepted(client):
    r = client.post("/backtest", json={**BODY, "start": "2024-01-02"}, headers=HDR)
    assert r.status_code == 200 and client.calls[0]["start"] == "2024-01-02"


@pytest.mark.parametrize("sp", [[1, 2], "n=3", 5])
def test_signal_parameters_non_dict_rejected(client, sp):
    r = client.post("/backtest", json={**BODY, "signal_parameters": sp}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


@pytest.mark.parametrize("field", ["timeout_s", "timeout", "BT_TIMEOUT_S"])
def test_caller_cannot_set_timeout(client, field):
    r = client.post("/backtest", json={**BODY, field: 1}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


# ---- timeout env ----

def test_timeout_default_120(client, monkeypatch):
    monkeypatch.delenv("BT_TIMEOUT_S")
    assert client.post("/backtest", json=BODY, headers=HDR).status_code == 200
    assert client.calls[0]["timeout_s"] == 120


@pytest.mark.parametrize("val", ["abc", "-1", "0", "999999"])
def test_timeout_env_invalid_is_sane(client, monkeypatch, val):
    monkeypatch.setenv("BT_TIMEOUT_S", val)
    r = client.post("/backtest", json=BODY, headers=HDR)
    assert r.status_code == 200, "invalid BT_TIMEOUT_S must not crash the request"
    t = client.calls[0]["timeout_s"]
    assert isinstance(t, (int, float)) and 0 < t <= 3600, f"unsafe timeout {t!r}"


# ---- concurrency / errors ----

def test_second_request_waits_then_succeeds(client, monkeypatch):
    monkeypatch.setattr(app_mod, "BUSY_WAIT_S", 5.0)
    started, release = threading.Event(), threading.Event()
    n = []

    def slow(**kw):
        n.append(1)
        if len(n) == 1:
            started.set()
            release.wait(5)
        return {"ok": True}

    monkeypatch.setattr(app_mod, "run_backtest", slow)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=client.post("/backtest", json=BODY, headers=HDR)))
    t.start()
    assert started.wait(5)
    threading.Timer(0.2, release.set).start()
    r = client.post("/backtest", json=BODY, headers=HDR)
    t.join(10)
    assert r.status_code == 200 and first["r"].status_code == 200 and len(n) == 2


def test_exception_releases_semaphore_and_500_leaks_nothing(client, monkeypatch):
    def boom(**kw):
        raise RuntimeError(f"kaboom {TOKEN} {API_KEY}")

    monkeypatch.setattr(app_mod, "run_backtest", boom)
    r = client.post("/backtest", json=BODY, headers=HDR)
    assert r.status_code == 500
    _no_secrets(r)
    assert "Traceback" not in r.text and "kaboom" not in r.text
    monkeypatch.setattr(app_mod, "run_backtest", lambda **kw: {"ok": True})
    r2 = client.post("/backtest", json=BODY, headers=HDR)
    assert r2.status_code == 200


# ---- http surface ----

def test_cors_preflight_no_allow_origin(client):
    r = client.options("/backtest", headers={"Origin": "https://evil.example",
                                             "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}
    r = client.post("/backtest", json=BODY, headers={**HDR, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


def test_get_backtest_405(client):
    assert client.get("/backtest", headers=HDR).status_code == 405
