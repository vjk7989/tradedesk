import threading

import pytest
from fastapi.testclient import TestClient

from bt_service import app as app_mod

TOKEN = "t" * 32
HDR = {"Authorization": f"Bearer {TOKEN}"}
BODY = {"code": "x", "symbols": ["A"], "start": "2024-01-01", "end": "2024-02-01"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BT_TOKEN", TOKEN)
    monkeypatch.setenv("BT_TIMEOUT_S", "77")
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    calls = []

    def fake(**kw):
        calls.append(kw)
        return {"ok": True, "metrics": {}, "equity": [], "trades": [], "warnings": []}

    monkeypatch.setattr(app_mod, "run_backtest", fake)
    with TestClient(app_mod.app) as c:
        c.calls = calls
        yield c


def test_healthz_no_auth(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_happy_path_passes_args(client):
    r = client.post("/backtest", json={**BODY, "capital": 5000, "costs": {"a": 1}, "source": "local",
                                       "signal_parameters": {"n": 3}}, headers=HDR)
    assert r.status_code == 200 and r.json()["ok"] is True
    kw = client.calls[0]
    assert kw["code"] == "x" and kw["symbols"] == ["A"] and kw["start"] == "2024-01-01"
    assert kw["capital"] == 5000 and kw["costs"] == {"a": 1} and kw["source"] == "local"
    assert kw["signal_parameters"] == {"n": 3} and kw["interval"] == "1D"
    assert kw["timeout_s"] == 77


def test_ok_false_is_200(client, monkeypatch):
    monkeypatch.setattr(app_mod, "run_backtest", lambda **kw: {"ok": False, "error": "nope"})
    r = client.post("/backtest", json=BODY, headers=HDR)
    assert r.status_code == 200 and r.json()["ok"] is False


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}])
def test_401(client, headers):
    assert client.post("/backtest", json=BODY, headers=headers).status_code == 401
    assert client.calls == []


@pytest.mark.parametrize("token", [None, "short"])
def test_503_without_token(client, monkeypatch, token):
    if token is None:
        monkeypatch.delenv("BT_TOKEN")
    else:
        monkeypatch.setenv("BT_TOKEN", token)
    r = client.post("/backtest", json=BODY, headers=HDR)
    assert r.status_code == 503 and "BT_TOKEN not configured" in r.text
    assert client.get("/healthz").status_code == 200


def test_422_extra_field(client):
    r = client.post("/backtest", json={**BODY, "timeout_s": 5}, headers=HDR)
    assert r.status_code == 422 and client.calls == []


def test_429_when_busy(client, monkeypatch):
    monkeypatch.setattr(app_mod, "BUSY_WAIT_S", 0.3)
    started, release = threading.Event(), threading.Event()

    def slow(**kw):
        started.set()
        release.wait(10)
        return {"ok": True}

    monkeypatch.setattr(app_mod, "run_backtest", slow)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=client.post("/backtest", json=BODY, headers=HDR)))
    t.start()
    assert started.wait(5)
    r = client.post("/backtest", json=BODY, headers=HDR)
    release.set()
    t.join(10)
    assert r.status_code == 429 and r.json() == {"error": "busy"}
    assert first["r"].status_code == 200


def test_413_content_length(client):
    r = client.post("/backtest", content=b"x" * (1024 * 1024 + 1), headers={**HDR, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_413_streamed(client):
    def gen():
        for _ in range(3):
            yield b"x" * (512 * 1024)

    r = client.post("/backtest", content=gen(), headers={**HDR, "Content-Type": "application/json"})
    assert r.status_code == 413
    assert client.calls == []
