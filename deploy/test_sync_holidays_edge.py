"""Owner-side edge tests for sync_holidays.py (TM2-4). Local fake OpenAlgo server only, no real network."""
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
KEY = "edge-key-7Q2w9Zx4-PLANTED"
ENDPOINT = "/api/v1/market/holidays"


def hol(date, closed, opened=(), htype="TRADING_HOLIDAY"):
    return {"date": date, "description": "x", "holiday_type": htype, "closed_exchanges": list(closed),
            "open_exchanges": [{"exchange": e, "start_time": 1, "end_time": 2} for e in opened]}


class Fake:
    """Fake OpenAlgo: answers every POST with the configured status and body; records path and JSON body."""

    def __init__(self):
        self.status, self.body, self.requests = 200, b"", []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n)
                try:
                    outer.requests.append((self.path, json.loads(raw)))
                except ValueError:
                    outer.requests.append((self.path, raw))
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(outer.body)))
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def reply(self, data=None, status="success", http=200, raw=None, **extra):
        self.status = http
        self.body = raw if raw is not None else json.dumps({"status": status, "data": data if data is not None else [], **extra}).encode()


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


def run(fake_url, risk, *extra, env=None, drop=(), cwd=None):
    e = {**os.environ, "OPENALGO_URL": fake_url, "OPENALGO_API_KEY": KEY, **(env or {})}
    for k in drop:
        e.pop(k, None)
    r = subprocess.run([sys.executable, str(SCRIPT), "--risk", str(risk), *extra],
                       capture_output=True, text=True, env=e, timeout=60, cwd=cwd)
    # The key must never be printed, on any path.
    assert KEY not in r.stdout and KEY not in r.stderr
    assert "Traceback" not in r.stderr
    return r


def mh(path):
    return json.loads(Path(path).read_text(encoding="utf-8")).get("marketHolidays")


def bak(path):
    return Path(path).with_name(Path(path).name + ".bak")


def trade_mcp_valid(doc):
    """Re-validate with trade-mcp's rules (src/config.ts): marketHolidays strict {NSE?, MCX?}, arrays of isoDate."""
    v = doc.get("marketHolidays", {})
    if not isinstance(v, dict) or set(v) - {"NSE", "MCX"}:
        return False
    for arr in v.values():
        if not isinstance(arr, list):
            return False
        for d in arr:
            # isoDate: /^\d{4}-\d{2}-\d{2}$/ (JS \d is ASCII) and Date round-trip
            if not isinstance(d, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", d):
                return False
            try:
                if datetime.date.fromisoformat(d).isoformat() != d:
                    return False
            except ValueError:
                return False
    return True


def files(d):
    return sorted(x.name for x in Path(d).iterdir())


# ------------------------------------------------ failures: exit non-zero, file byte-identical, no .bak

FAILS = {
    "http 500": dict(http=500, raw=b'{"status": "error", "message": "boom"}'),
    "http 401": dict(http=401, raw=b'{"status": "error", "message": "Invalid openalgo apikey"}'),
    "http 404 html": dict(http=404, raw=b"<html>Not Found</html>"),
    "status error": dict(data=[hol("2026-01-26", ["NSE"])], status="error"),
    "status missing": dict(raw=json.dumps({"data": [hol("2026-01-26", ["NSE"])]}).encode()),
    "status Success (case)": dict(data=[hol("2026-01-26", ["NSE"])], status="Success"),
    "malformed json": dict(raw=b'{"status": "success", "data": ['),
    "empty body": dict(raw=b""),
    "json array top level": dict(raw=b"[]"),
    "data is object": dict(raw=b'{"status": "success", "data": {"date": "2026-01-26"}}'),
    "data null": dict(raw=b'{"status": "success", "data": null}'),
    "non-utf8 body": dict(raw=b'{"status": "success", "data": [], "x": "\xff\xfe"}'),
}


@pytest.mark.parametrize("case", list(FAILS))
def test_response_failure_leaves_file_untouched(fake, risk, case):
    fake.reply(**FAILS[case])
    before = risk.read_bytes()
    r = run(fake.url, risk)
    assert r.returncode != 0
    assert r.stderr.strip()
    assert risk.read_bytes() == before
    assert files(risk.parent) == ["risk.json"]


BAD_DATES = [
    "2026-02-30", "2026-1-5", "2026-01-5", "26-01-2026", "2026/01/26", "20260126",
    "2026-01-26T00:00:00", "2026-01-26T00:00:00Z", "2026-01-26 00:00:00", " 2026-01-26", "2026-01-26\n",
    "2026-13-01", "2026-00-10", "2025-02-29", "0000-01-01", "\u0662\u0660\u0662\u0666-01-26", "", None, 20260126,
    ["2026-01-26"],
]


@pytest.mark.parametrize("bad", BAD_DATES, ids=[repr(b) for b in BAD_DATES])
def test_malformed_date_anywhere_fails_whole_sync(fake, risk, bad):
    # One bad entry among good ones: nothing is written (no partial update).
    fake.reply([hol("2026-01-26", ["NSE", "MCX"]), {**hol("2026-03-10", ["NSE"]), "date": bad}])
    before = risk.read_bytes()
    r = run(fake.url, risk)
    assert r.returncode != 0
    assert risk.read_bytes() == before
    assert files(risk.parent) == ["risk.json"]


def test_malformed_date_also_fails_in_dry_run(fake, risk):
    fake.reply([hol("2026-02-30", ["NSE"])])
    r = run(fake.url, risk, "--dry-run")
    assert r.returncode != 0
    assert risk.read_bytes() == EXAMPLE.read_bytes()


def test_leap_day_in_leap_year_is_accepted(fake, risk):
    fake.reply([hol("2028-02-29", ["NSE"])])
    assert run(fake.url, risk).returncode == 0
    assert mh(risk) == {"NSE": ["2028-02-29"]}


@pytest.mark.parametrize("entry", [
    "2026-01-26",
    None,
    {"date": "2026-01-26", "closed_exchanges": "NSE", "open_exchanges": []},
    {"date": "2026-01-26", "closed_exchanges": ["NSE"], "open_exchanges": {"exchange": "MCX"}},
], ids=["string entry", "null entry", "closed is string", "open is object"])
def test_malformed_entry_shape_fails(fake, risk, entry):
    fake.reply([hol("2026-05-01", ["MCX"]), entry])
    r = run(fake.url, risk)
    assert r.returncode != 0
    assert risk.read_bytes() == EXAMPLE.read_bytes()
    assert files(risk.parent) == ["risk.json"]


def test_connection_refused_leaves_file_untouched(risk):
    f = Fake()
    url = f.url
    f.srv.shutdown()
    f.srv.server_close()
    r = run(url, risk)
    assert r.returncode != 0
    assert risk.read_bytes() == EXAMPLE.read_bytes()


# ------------------------------------------------ empty list

def test_empty_list_changes_nothing(fake, risk):
    fake.reply([])
    r = run(fake.url, risk)
    assert risk.read_bytes() == EXAMPLE.read_bytes()
    assert files(risk.parent) == ["risk.json"]
    assert r.returncode == 0  # not an error case in the brief; the file is simply unchanged


def test_empty_list_keeps_existing_holidays(fake, risk):
    src = EXAMPLE.read_text().replace('"marketHolidays": {}', '"marketHolidays": {"NSE": ["2026-01-26"], "MCX": []}')
    risk.write_text(src)
    fake.reply([])
    run(fake.url, risk)
    assert risk.read_text() == src


# ------------------------------------------------ mapping: partial sessions excluded

def test_mixed_list_partial_sessions_excluded(fake, risk):
    fake.reply([
        hol("2026-03-10", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD"], ["MCX"]),  # MCX evening session
        hol("2026-11-08", [], ["NSE", "BSE", "MCX"], "SPECIAL_SESSION"),         # Muhurat
        hol("2026-02-19", [], [], "SETTLEMENT_HOLIDAY"),
        hol("2026-04-03", ["MCX"], ["MCX"]),                                     # listed both: open wins
        hol("2026-04-14", ["NSE", "MCX"], ["NSE"]),                              # NSE open, MCX closed
        hol("2026-06-01", ["BCD", "NCO", "CRYPTO"]),
        hol("2026-06-02", ["nse", "mcx"]),                                       # wrong case: not a known code
        hol("2026-08-15", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX"]),
    ])
    assert run(fake.url, risk).returncode == 0
    assert mh(risk) == {"NSE": ["2026-03-10", "2026-08-15"], "MCX": ["2026-04-14", "2026-08-15"]}


def test_bse_only_closure_maps_to_nse_group(fake, risk):
    fake.reply([hol("2026-07-07", ["BSE"])])
    run(fake.url, risk)
    assert mh(risk) == {"NSE": ["2026-07-07"]}


def test_only_partial_sessions_changes_nothing(fake, risk):
    fake.reply([hol("2026-11-08", [], ["NSE", "MCX"], "SPECIAL_SESSION")])
    run(fake.url, risk)
    assert risk.read_bytes() == EXAMPLE.read_bytes()
    assert files(risk.parent) == ["risk.json"]


def test_open_exchanges_as_plain_strings_also_count_as_open(fake, risk):
    fake.reply([{"date": "2026-03-10", "closed_exchanges": ["NSE", "MCX"], "open_exchanges": ["MCX"]}])
    run(fake.url, risk)
    assert mh(risk) == {"NSE": ["2026-03-10"]}


# ------------------------------------------------ merge, duplicates, idempotency, .bak

def test_duplicates_within_one_response(fake, risk):
    fake.reply([hol("2026-01-26", ["NSE"]), hol("2026-01-26", ["BSE", "NFO"]), hol("2026-01-26", ["NSE"])])
    run(fake.url, risk)
    assert mh(risk) == {"NSE": ["2026-01-26"]}


def test_duplicates_across_runs_and_bak_is_previous_file(fake, risk):
    fake.reply([hol("2026-08-15", ["NSE", "MCX"])])
    assert run(fake.url, risk).returncode == 0
    after1 = risk.read_bytes()
    assert bak(risk).read_bytes() == EXAMPLE.read_bytes()

    fake.reply([hol("2026-08-15", ["NSE", "MCX"]), hol("2026-01-26", ["NSE", "MCX"])])
    assert run(fake.url, risk).returncode == 0
    after2 = risk.read_bytes()
    assert mh(risk) == {"NSE": ["2026-01-26", "2026-08-15"], "MCX": ["2026-01-26", "2026-08-15"]}
    assert bak(risk).read_bytes() == after1  # .bak = the file as it was just before this write

    for _ in range(2):  # same data again: no change, .bak not rotated
        assert run(fake.url, risk).returncode == 0
        assert risk.read_bytes() == after2
        assert bak(risk).read_bytes() == after1
    assert files(risk.parent) == ["risk.json", "risk.json.bak"]


def test_existing_holidays_merged_and_sorted(fake, risk):
    risk.write_text(EXAMPLE.read_text().replace(
        '"marketHolidays": {}', '"marketHolidays": {"MCX": ["2026-12-25", "2026-01-01"], "NSE": ["2026-10-02"]}'))
    fake.reply([hol("2026-05-01", ["MCX"]), hol("2026-01-01", ["MCX"]), hol("2025-12-31", ["NSE"])])
    assert run(fake.url, risk).returncode == 0
    assert mh(risk) == {"MCX": ["2026-01-01", "2026-05-01", "2026-12-25"], "NSE": ["2025-12-31", "2026-10-02"]}
    # Group order inside marketHolidays is kept (MCX first, as in the file).
    assert list(mh(risk)) == ["MCX", "NSE"]


def test_unsorted_existing_with_nothing_new(fake, risk):
    src = EXAMPLE.read_text().replace('"marketHolidays": {}', '"marketHolidays": {"NSE": ["2026-12-25", "2026-01-26"]}')
    risk.write_text(src)
    fake.reply([hol("2026-01-26", ["NSE"])])
    assert run(fake.url, risk).returncode == 0
    out = mh(risk)["NSE"]
    assert sorted(set(out)) == ["2026-01-26", "2026-12-25"]
    assert len(out) == len(set(out))


def test_existing_invalid_group_key_refused(fake, risk):
    src = EXAMPLE.read_text().replace('"marketHolidays": {}', '"marketHolidays": {"NSE": [], "nse": []}')
    risk.write_text(src)
    fake.reply([hol("2026-01-26", ["NSE"])])
    assert run(fake.url, risk).returncode != 0
    assert risk.read_text() == src


# ------------------------------------------------ unrelated keys, key order, bytes preserved

ODD = (
    '{\n'
    '\t"zeta": "first \\"quoted\\" }{ ][ marketHolidays",\n'
    '\t"alpha": {"nested": {"marketHolidays": {"NSE": ["1999-01-01"]}}, "arr": [1,2 ,3]},\n'
    '\t"marketHolidays": {\n\t\t"NSE": ["2026-01-26"]\n\t},\n'
    '\t"unicode": "\u20b9 \u65e5\u672c \\u00e9",\n'
    '\t"num": 1.50e3,\n'
    '\t"last": null\n'
    '}'
)


def test_unrelated_keys_order_and_bytes_preserved(fake, tmp_path):
    p = tmp_path / "risk.json"
    p.write_bytes(ODD.encode("utf-8"))
    fake.reply([hol("2026-08-15", ["NSE", "MCX"])])
    assert run(fake.url, p).returncode == 0
    out = p.read_bytes().decode("utf-8")
    start = ODD.index('{\n\t\t"NSE"')
    end = ODD.index("\t},\n") + 2
    assert out.startswith(ODD[:start])
    assert out.endswith(ODD[end:])
    doc = json.loads(out)
    assert list(doc) == ["zeta", "alpha", "marketHolidays", "unicode", "num", "last"]
    assert doc["alpha"]["nested"]["marketHolidays"] == {"NSE": ["1999-01-01"]}  # nested key untouched
    assert doc["marketHolidays"] == {"NSE": ["2026-01-26", "2026-08-15"], "MCX": ["2026-08-15"]}
    assert bak(p).read_bytes() == ODD.encode("utf-8")


def test_example_file_other_lines_identical(fake, risk):
    fake.reply([hol("2026-08-15", ["NSE", "MCX"])])
    run(fake.url, risk)
    old = EXAMPLE.read_text().splitlines()
    new = risk.read_text().splitlines()
    assert len(old) == len(new)
    diff = [i for i, (a, b) in enumerate(zip(old, new)) if a != b]
    assert len(diff) == 1 and '"marketHolidays"' in new[diff[0]]
    assert list(json.loads(risk.read_text())) == list(json.loads(EXAMPLE.read_text()))


def test_empty_object_file_gets_key(fake, tmp_path):
    p = tmp_path / "risk.json"
    p.write_text("{}")
    fake.reply([hol("2026-08-15", ["MCX"])])
    assert run(fake.url, p).returncode == 0
    assert json.loads(p.read_text()) == {"marketHolidays": {"MCX": ["2026-08-15"]}}


@pytest.mark.parametrize("src", ["[]", '"x"', "null", '{"marketHolidays": []}', '{"marketHolidays": null}'])
def test_risk_json_wrong_shape_refused(fake, tmp_path, src):
    p = tmp_path / "risk.json"
    p.write_text(src)
    fake.reply([hol("2026-08-15", ["MCX"])])
    assert run(fake.url, p).returncode != 0
    assert p.read_text() == src
    assert files(tmp_path) == ["risk.json"]


# ------------------------------------------------ --dry-run

def test_dry_run_writes_nothing_and_lists_only_new_dates(fake, risk):
    risk.write_text(EXAMPLE.read_text().replace('"marketHolidays": {}', '"marketHolidays": {"MCX": ["2026-08-15"]}'))
    before = risk.read_bytes()
    fake.reply([hol("2026-08-15", ["NSE", "MCX"]), hol("2026-11-08", [], ["NSE"], "SPECIAL_SESSION")])
    r = run(fake.url, risk, "--dry-run")
    assert r.returncode == 0
    assert risk.read_bytes() == before
    assert files(risk.parent) == ["risk.json"]
    lines = {l.split(":", 1)[0]: l for l in r.stdout.splitlines() if ":" in l}
    assert "2026-08-15" in lines["NSE"]
    assert "2026-08-15" not in lines["MCX"]
    assert "2026-11-08" not in r.stdout  # partial session never proposed


def test_dry_run_on_missing_key_writes_nothing(fake, tmp_path):
    p = tmp_path / "risk.json"
    p.write_text('{"a": 1}')
    fake.reply([hol("2026-08-15", ["NSE"])])
    assert run(fake.url, p, "--dry-run").returncode == 0
    assert p.read_text() == '{"a": 1}'
    assert files(tmp_path) == ["risk.json"]


# ------------------------------------------------ OPENALGO_URL forms

@pytest.mark.parametrize("suffix,expected_path", [
    ("/", ENDPOINT),
    ("//", ENDPOINT),
    ("/openalgo", "/openalgo" + ENDPOINT),
    ("/openalgo/", "/openalgo" + ENDPOINT),
])
def test_openalgo_url_trailing_slash_and_prefix(fake, risk, suffix, expected_path):
    fake.reply([hol("2026-08-15", ["NSE"])])
    assert run(fake.url + suffix, risk).returncode == 0
    assert fake.requests[0][0] == expected_path
    assert mh(risk) == {"NSE": ["2026-08-15"]}


def test_openalgo_url_surrounding_whitespace(fake, risk):
    fake.reply([hol("2026-08-15", ["NSE"])])
    assert run(f"  {fake.url}/ \n", risk).returncode == 0
    assert fake.requests[0][0] == ENDPOINT


@pytest.mark.parametrize("url", ["ftp://127.0.0.1:1/", "127.0.0.1:5000", "file:///C:/openalgo", "http://"])
def test_openalgo_url_bad_scheme_refused(risk, url):
    r = run(url, risk)
    assert r.returncode != 0
    assert "OPENALGO_URL" in r.stderr
    assert risk.read_bytes() == EXAMPLE.read_bytes()


def test_request_body_is_exactly_apikey_and_year(fake, risk):
    fake.reply([])
    run(fake.url, risk, "--year", "2027", env={"OPENALGO_API_KEY": f"  {KEY}\t"})
    assert fake.requests[0] == (ENDPOINT, {"apikey": KEY, "year": 2027})  # key trimmed


@pytest.mark.parametrize("year", ["abc", "2027.5", ""])
def test_non_integer_year_rejected_before_network(fake, risk, year):
    r = run(fake.url, risk, "--year", year)
    assert r.returncode != 0
    assert fake.requests == []
    assert risk.read_bytes() == EXAMPLE.read_bytes()


# ------------------------------------------------ env: clear error, no traceback, no key

@pytest.mark.parametrize("drop,setv", [
    (("OPENALGO_URL",), {}),
    (("OPENALGO_API_KEY",), {}),
    (("OPENALGO_URL", "OPENALGO_API_KEY"), {}),
    ((), {"OPENALGO_URL": "   "}),
    ((), {"OPENALGO_API_KEY": " \t "}),
])
def test_missing_env_clear_error(fake, risk, drop, setv):
    fake.reply([hol("2026-08-15", ["NSE"])])
    r = run(fake.url, risk, drop=drop, env=setv)
    assert r.returncode != 0
    assert "OPENALGO_URL" in r.stderr and "OPENALGO_API_KEY" in r.stderr
    assert fake.requests == []
    assert risk.read_bytes() == EXAMPLE.read_bytes()


def test_missing_risk_arg_is_usage_error(fake):
    e = {**os.environ, "OPENALGO_URL": fake.url, "OPENALGO_API_KEY": KEY}
    r = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env=e, timeout=60)
    assert r.returncode != 0 and "--risk" in r.stderr and KEY not in r.stderr


# ------------------------------------------------ API key planted in responses is never printed

PLANTED = {
    "500 body": dict(http=500, raw=json.dumps({"status": "error", "message": f"bad key {KEY}"}).encode()),
    "403 body": dict(http=403, raw=f"Forbidden apikey={KEY}".encode()),
    "status error message": dict(raw=json.dumps({"status": "error", "message": f"Invalid apikey {KEY}"}).encode()),
    "html body": dict(raw=f"<html>{KEY}</html>".encode()),
    "in date": dict(data=[hol(KEY, ["NSE"])]),
    "in exchange list": dict(data=[{"date": "2026-01-26", "closed_exchanges": KEY, "open_exchanges": []}]),
    "as entry": dict(data=[KEY]),
}


@pytest.mark.parametrize("case", list(PLANTED))
def test_planted_key_never_printed(fake, risk, case):
    fake.reply(**PLANTED[case])
    r = run(fake.url, risk)  # run() asserts KEY not in stdout/stderr
    assert r.returncode != 0
    assert risk.read_bytes() == EXAMPLE.read_bytes()


def test_planted_key_in_unknown_exchange_name_not_printed_on_success(fake, risk):
    fake.reply([hol("2026-01-26", ["NSE", KEY])])
    r = run(fake.url, risk)
    assert r.returncode == 0
    assert KEY not in risk.read_text()
    run(fake.url, risk, "--dry-run")


def test_key_with_regex_and_json_specials_never_printed(fake, risk):
    special = 'k$y.*"\\{}[]' + KEY
    fake.reply(http=500, raw=json.dumps({"message": special}).encode())
    e = {**os.environ, "OPENALGO_URL": fake.url, "OPENALGO_API_KEY": special}
    r = subprocess.run([sys.executable, str(SCRIPT), "--risk", str(risk)], capture_output=True, text=True, env=e, timeout=60)
    assert r.returncode != 0
    assert special not in r.stdout + r.stderr and KEY not in r.stdout + r.stderr


# ------------------------------------------------ Windows paths

def test_windows_path_with_spaces(fake, tmp_path):
    d = tmp_path / "Program Files" / "trade desk"
    d.mkdir(parents=True)
    p = d / "risk (prod).json"
    p.write_bytes(EXAMPLE.read_bytes())
    fake.reply([hol("2026-08-15", ["NSE"])])
    arg = str(p).replace("/", "\\") if os.name == "nt" else str(p)
    assert run(fake.url, arg).returncode == 0
    assert mh(p) == {"NSE": ["2026-08-15"]}
    assert bak(p).read_bytes() == EXAMPLE.read_bytes()
    assert files(d) == ["risk (prod).json", "risk (prod).json.bak"]  # no temp file left


def test_non_ascii_path_succeeds_when_stdout_is_a_pipe(fake, tmp_path):
    # On Windows a piped stdout (scheduled task, log redirect) uses the ANSI code page;
    # printing the path must not turn a completed write into "error: unexpected ..." / exit 1.
    d = tmp_path / "trade desk ₹ 日本"
    d.mkdir()
    p = d / "risk.json"
    p.write_bytes(EXAMPLE.read_bytes())
    fake.reply([hol("2026-08-15", ["NSE"])])
    r = run(fake.url, p, env={"PYTHONIOENCODING": "", "PYTHONUTF8": "0"})
    assert r.returncode == 0, r.stderr
    assert mh(p) == {"NSE": ["2026-08-15"]}


def test_relative_path_with_spaces_from_cwd(fake, tmp_path):
    d = tmp_path / "my deploy"
    d.mkdir()
    (d / "risk.json").write_bytes(EXAMPLE.read_bytes())
    fake.reply([hol("2026-08-15", ["MCX"])])
    rel = os.path.join("my deploy", "risk.json")
    assert run(fake.url, rel, cwd=str(tmp_path)).returncode == 0
    assert mh(d / "risk.json") == {"MCX": ["2026-08-15"]}


@pytest.mark.skipif(os.name != "nt", reason="Windows-only path form")
def test_windows_forward_slash_path(fake, tmp_path):
    d = tmp_path / "a b"
    d.mkdir()
    p = d / "risk.json"
    p.write_bytes(EXAMPLE.read_bytes())
    fake.reply([hol("2026-08-15", ["NSE"])])
    assert run(fake.url, str(p).replace("\\", "/")).returncode == 0
    assert mh(p) == {"NSE": ["2026-08-15"]}


def test_crlf_file_keeps_crlf(fake, tmp_path):
    p = tmp_path / "risk.json"
    src = EXAMPLE.read_text().replace("\r\n", "\n").replace("\n", "\r\n").encode()
    p.write_bytes(src)
    fake.reply([hol("2026-08-15", ["NSE"])])
    run(fake.url, p)
    out = p.read_bytes()
    assert out.count(b"\r\n") == src.count(b"\r\n")
    assert b"\n" not in out.replace(b"\r\n", b"")


def test_missing_risk_file_clear_error(fake, tmp_path):
    fake.reply([hol("2026-08-15", ["NSE"])])
    r = run(fake.url, tmp_path / "no such dir" / "risk.json")
    assert r.returncode != 0 and r.stderr.strip()
    assert not (tmp_path / "no such dir").exists()


# ------------------------------------------------ output re-validated with trade-mcp rules

def test_output_revalidated_with_trade_mcp_rules(fake, risk):
    fake.reply([
        hol("2026-01-26", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX"]),
        hol("2026-03-10", ["NSE", "BSE", "NFO", "BFO", "CDS", "BCD"], ["MCX"]),
        hol("2026-06-01", ["BCD", "NCO", "CRYPTO"]),
        hol("2028-02-29", ["MCX"]),
        hol("2026-12-31", ["CDS"]),
    ])
    assert run(fake.url, risk).returncode == 0
    doc = json.loads(risk.read_text())
    assert trade_mcp_valid(doc)
    assert set(doc["marketHolidays"]) <= {"NSE", "MCX"}
    for arr in doc["marketHolidays"].values():
        assert arr == sorted(set(arr))


def test_trade_mcp_validator_rejects_what_it_should():
    # Guard: the local re-validator really is strict (otherwise the test above proves nothing).
    assert not trade_mcp_valid({"marketHolidays": {"BSE": []}})
    assert not trade_mcp_valid({"marketHolidays": {"NSE": ["2026-02-30"]}})
    assert not trade_mcp_valid({"marketHolidays": {"NSE": ["2026-1-5"]}})
    assert not trade_mcp_valid({"marketHolidays": {"NSE": "2026-01-05"}})
    assert trade_mcp_valid({"marketHolidays": {"NSE": ["2026-01-05"], "MCX": []}})
