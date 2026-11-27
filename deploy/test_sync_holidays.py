"""Tests for sync_holidays.py using a local fake OpenAlgo server (no real network)."""
import datetime
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "sync_holidays.py"
EXAMPLE = Path(__file__).resolve().parent / "risk.example.json"
KEY = "test-key-9f3a7c1e-UNIQUE"


def closure(date, closed, opened=()):
    return {"date": date, "description": "x", "holiday_type": "TRADING_HOLIDAY",
            "closed_exchanges": list(closed),
            "open_exchanges": [{"exchange": e, "start_time": 1, "end_time": 2} for e in opened]}


class Fake:
    def __init__(self):
        self.status, self.body, self.requests = 200, b"", []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                outer.requests.append((self.path, json.loads(self.rfile.read(n))))
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def reply(self, data=None, status="success", http=200, raw=None):
        self.status = http
        self.body = raw if raw is not None else json.dumps(
            {"status": status, "data": data or []}).encode()


@pytest.fixture
def fake():
    f = Fake()
    yield f
    f.srv.shutdown()
    f.srv.server_close()


@pytest.fixture
def risk(tmp_path):
    p = tmp_path / "risk.json"
    p.write_bytes(EXAMPLE.read_bytes())
    return p


def run(fake, risk, *extra, env=None):
    e = {**os.environ, "OPENALGO_URL": fake.url, "OPENALGO_API_KEY": KEY, **(env or {})}
    r = subprocess.run([sys.executable, str(SCRIPT), "--risk", str(risk), *extra],
                       capture_output=True, text=True, env=e, timeout=60)
    assert KEY not in r.stdout and KEY not in r.stderr
    return r


def is_iso(s):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        return datetime.date.fromisoformat(s).isoformat() == s
    except ValueError:
        return False


def split_mh(text):
    """Return (before, after) around the marketHolidays value line."""
    m = re.search(r'("marketHolidays": ).*', text)
    return text[:m.start(1)], text[m.end():]


DATA = [
    closure("2026-01-26", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX"]),
    closure("2026-03-10", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD"], ["MCX"]),
    closure("2026-05-01", ["MCX"]),
    closure("2026-11-08", [], ["NSE", "MCX"]),  # Muhurat: partial for both
    closure("2026-02-19", []),                  # settlement-only
    closure("2026-06-01", ["BCD", "NCO"]),      # ignored exchanges
]


def result(risk):
    return json.loads(risk.read_text())["marketHolidays"]


def test_mapping_and_partial_excluded(fake, risk):
    fake.reply(DATA)
    assert run(fake, risk).returncode == 0
    assert result(risk) == {"NSE": ["2026-01-26", "2026-03-10"],
                            "MCX": ["2026-01-26", "2026-05-01"]}


def test_each_nse_group_exchange_maps_to_nse(fake, risk):
    fake.reply([closure(f"2026-04-0{i+1}", [x]) for i, x in enumerate(["NSE", "BSE", "NFO", "BFO", "CDS"])])
    assert run(fake, risk).returncode == 0
    assert result(risk) == {"NSE": [f"2026-04-0{i}" for i in range(1, 6)]}


def test_merge_union_sorted_dedup(fake, risk):
    orig = risk.read_text().replace('"marketHolidays": {}',
        '"marketHolidays": {"NSE": ["2026-12-25", "2026-01-26"], "MCX": []}')
    risk.write_text(orig)
    fake.reply(DATA)
    assert run(fake, risk).returncode == 0
    assert result(risk) == {"NSE": ["2026-01-26", "2026-03-10", "2026-12-25"],
                            "MCX": ["2026-01-26", "2026-05-01"]}


def test_only_nonempty_or_present_keys_written(fake, risk):
    fake.reply([closure("2026-05-01", ["MCX"])])
    assert run(fake, risk).returncode == 0
    assert result(risk) == {"MCX": ["2026-05-01"]}


def test_idempotent_no_bak_churn(fake, risk):
    fake.reply(DATA)
    run(fake, risk)
    first = risk.read_bytes()
    bak = risk.with_name("risk.json.bak")
    assert bak.read_bytes() == EXAMPLE.read_bytes()
    bak_mtime = bak.stat().st_mtime_ns
    risk_mtime = risk.stat().st_mtime_ns
    assert run(fake, risk).returncode == 0
    assert risk.read_bytes() == first
    assert bak.read_bytes() == EXAMPLE.read_bytes()
    assert bak.stat().st_mtime_ns == bak_mtime and risk.stat().st_mtime_ns == risk_mtime


def test_other_bytes_unchanged(fake, risk):
    fake.reply(DATA)
    before = risk.read_text()
    run(fake, risk)
    after = risk.read_text()
    b0, a0 = split_mh(before)
    b1, a1 = split_mh(after)
    assert (b0, a0) == (b1, a1)
    assert '["NSE", "BSE", "NFO", "CRYPTO"]' in after  # inline arrays preserved


def test_other_bytes_unchanged_when_key_in_middle_crlf(fake, tmp_path):
    p = tmp_path / "risk.json"
    src = b'{\r\n    "a": [1, 2],\r\n    "marketHolidays": {"NSE": ["2026-01-01"]},\r\n    "b":   {"x": "marketHolidays"}\r\n}\r\n'
    p.write_bytes(src)
    fake.reply([closure("2026-01-26", ["NSE"])])
    assert run(fake, p).returncode == 0
    new = p.read_bytes()
    pre, post = src.split(b'{"NSE": ["2026-01-01"]}')
    assert new.startswith(pre) and new.endswith(post)
    assert json.loads(new)["marketHolidays"] == {"NSE": ["2026-01-01", "2026-01-26"]}


def test_key_absent_inserted_last_with_indent(fake, tmp_path):
    p = tmp_path / "risk.json"
    src = '{\n    "a": [1, 2],\n    "b": {"k": "}"}\n}\n'
    p.write_text(src)
    fake.reply([closure("2026-01-26", ["NSE"])])
    assert run(fake, p).returncode == 0
    out = p.read_text()
    assert out == '{\n    "a": [1, 2],\n    "b": {"k": "}"},\n    "marketHolidays": {"NSE": ["2026-01-26"]}\n}\n'


def test_output_schema_valid(fake, risk):
    fake.reply(DATA)
    run(fake, risk)
    mh = result(risk)
    assert set(mh) <= {"NSE", "MCX"}
    assert all(is_iso(d) for v in mh.values() for d in v)


@pytest.mark.parametrize("case", ["http500", "status", "baddate", "badjson", "feb30", "nodata"])
def test_failures_leave_file_untouched(fake, risk, case):
    if case == "http500":
        fake.reply(raw=b'{"error": "boom ' + KEY.encode() + b'"}', http=500)
    elif case == "status":
        fake.reply(DATA, status="error")
    elif case == "baddate":
        fake.reply(DATA + [closure("26-01-2026", ["NSE"])])
    elif case == "feb30":
        fake.reply(DATA + [closure("2026-02-30", ["NSE"])])
    elif case == "badjson":
        fake.reply(raw=b"<html>not json " + KEY.encode())
    else:
        fake.reply(raw=b'{"status": "success"}')
    before = risk.read_bytes()
    r = run(fake, risk)
    assert r.returncode != 0
    assert risk.read_bytes() == before
    assert not risk.with_name("risk.json.bak").exists()


def test_invalid_risk_json(fake, tmp_path):
    p = tmp_path / "risk.json"
    p.write_text("{not json")
    fake.reply(DATA)
    assert run(fake, p).returncode != 0
    assert p.read_text() == "{not json"
    assert run(fake, tmp_path / "missing.json").returncode != 0


def test_missing_env(fake, risk):
    for name in ("OPENALGO_URL", "OPENALGO_API_KEY"):
        env = {**os.environ, "OPENALGO_URL": fake.url, "OPENALGO_API_KEY": KEY}
        del env[name]
        r = subprocess.run([sys.executable, str(SCRIPT), "--risk", str(risk)],
                           capture_output=True, text=True, env=env, timeout=60)
        assert r.returncode != 0
    assert risk.read_bytes() == EXAMPLE.read_bytes()


def test_connection_refused_no_key_leak(risk):
    f = Fake()
    f.srv.shutdown(); f.srv.server_close()
    r = run(f, risk)
    assert r.returncode != 0 and risk.read_bytes() == EXAMPLE.read_bytes()


def test_request_body_carries_key_and_year(fake, risk):
    fake.reply(DATA)
    run(fake, risk, "--year", "2027")
    path, body = fake.requests[0]
    assert path == "/api/v1/market/holidays"
    assert body == {"apikey": KEY, "year": 2027}
    run(fake, risk)
    assert "year" not in fake.requests[1][1]


def test_dry_run_writes_nothing(fake, risk):
    fake.reply(DATA)
    r = run(fake, risk, "--dry-run")
    assert r.returncode == 0
    assert "2026-03-10" in r.stdout and "2026-05-01" in r.stdout
    assert risk.read_bytes() == EXAMPLE.read_bytes()
    assert not risk.with_name("risk.json.bak").exists()
    assert list(risk.parent.iterdir()) == [risk]


def test_dry_run_prints_only_additions(fake, risk):
    risk.write_text(EXAMPLE.read_text().replace('"marketHolidays": {}', '"marketHolidays": {"NSE": ["2026-01-26"]}'))
    fake.reply(DATA)
    r = run(fake, risk, "--dry-run")
    nse_line = [l for l in r.stdout.splitlines() if l.startswith("NSE:")][0]
    assert "2026-01-26" not in nse_line and "2026-03-10" in nse_line


def test_path_with_spaces(fake, tmp_path):
    d = tmp_path / "my deploy dir"
    d.mkdir()
    p = d / "risk file.json"
    p.write_bytes(EXAMPLE.read_bytes())
    fake.reply(DATA)
    assert run(fake, p).returncode == 0
    assert result(p)["NSE"] == ["2026-01-26", "2026-03-10"]
    assert (d / "risk file.json.bak").read_bytes() == EXAMPLE.read_bytes()
    assert sorted(x.name for x in d.iterdir()) == ["risk file.json", "risk file.json.bak"]


@pytest.mark.parametrize("mh", ['{"NSE": [], "BSE": ["2026-01-01"]}', '{"NSE": "2026-01-01"}', '{"MCX": ["2026-02-30"]}'])
def test_invalid_existing_market_holidays(fake, risk, mh):
    risk.write_text(EXAMPLE.read_text().replace('"marketHolidays": {}', f'"marketHolidays": {mh}'))
    before = risk.read_bytes()
    fake.reply(DATA)
    assert run(fake, risk).returncode != 0
    assert risk.read_bytes() == before
    assert not risk.with_name("risk.json.bak").exists()
