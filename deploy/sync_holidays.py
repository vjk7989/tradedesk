#!/usr/bin/env python3
"""Sync exchange holidays from OpenAlgo into risk.json's ``marketHolidays``.

Usage: python deploy/sync_holidays.py --risk deploy/risk.json [--year 2027] [--dry-run]
Env:   OPENALGO_URL, OPENALGO_API_KEY (the key is never printed).

Only the value of the top-level "marketHolidays" key is rewritten, textually,
so every other byte of risk.json is preserved. See docs/holidays.md.
Standard library only.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Exchange -> risk.json group. An exchange absent here is ignored.
GROUPS = {
    "NSE": "NSE", "BSE": "NSE", "NFO": "NSE", "BFO": "NSE", "CDS": "NSE",
    "MCX": "MCX",
}
KEY = "marketHolidays"
HTTP_TIMEOUT_S = 15
MAX_BODY = 8 * 1024 * 1024
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_WS = " \t\r\n"


class SyncError(Exception):
    pass


def is_iso_date(s) -> bool:
    """Same rule as trade-mcp isoDate: YYYY-MM-DD and a real calendar date."""
    if not isinstance(s, str) or not _DATE_RE.fullmatch(s):
        return False
    try:
        return datetime.date.fromisoformat(s).isoformat() == s
    except ValueError:
        return False


# ---------------------------------------------------------------- API

def fetch_holidays(base_url: str, api_key: str, year: int | None):
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SyncError("OPENALGO_URL must be an http(s) URL")
    url = base_url.rstrip("/") + "/api/v1/market/holidays"
    body = {"apikey": api_key}
    if year is not None:
        body["year"] = year
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            raw = resp.read(MAX_BODY + 1)
    except urllib.error.HTTPError as e:
        raise SyncError(f"OpenAlgo returned HTTP {e.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise SyncError(f"could not reach OpenAlgo: {type(e).__name__}") from None
    if len(raw) > MAX_BODY:
        raise SyncError("OpenAlgo response too large")
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SyncError("OpenAlgo response is not valid JSON") from None
    if not isinstance(doc, dict) or doc.get("status") != "success":
        raise SyncError("OpenAlgo status is not 'success'")
    if not isinstance(doc.get("data"), list):
        raise SyncError("OpenAlgo response has no 'data' array")
    return doc["data"]


def map_holidays(entries) -> dict[str, set[str]]:
    """Full closures only; see docs/holidays.md for the rule."""
    out: dict[str, set[str]] = {"NSE": set(), "MCX": set()}
    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            raise SyncError(f"data[{i}] is not an object")
        d = e.get("date")
        if not is_iso_date(d):
            raise SyncError(f"data[{i}] has a malformed date")
        closed = e.get("closed_exchanges", [])
        opened = e.get("open_exchanges", [])
        if not isinstance(closed, list) or not isinstance(opened, list):
            raise SyncError(f"data[{i}] has malformed exchange lists")
        open_names = {
            (o.get("exchange") if isinstance(o, dict) else o) for o in opened
        }
        for ex in closed:
            # Listed as open (special session) wins over closed: not a full closure.
            if isinstance(ex, str) and ex in GROUPS and ex not in open_names:
                out[GROUPS[ex]].add(d)
    return out


# ------------------------------------------------- textual risk.json edit

def _find_top_level_value_span(text: str, key: str):
    """Return (start, end) of the top-level value of `key`, or None.
    Also returns end offset of the last top-level value via second element."""
    dec = json.JSONDecoder()
    i = text.index("{")
    i += 1
    found = None
    last_end = None
    n = len(text)
    while True:
        while i < n and text[i] in _WS + ",":
            i += 1
        if i >= n or text[i] == "}":
            return found, last_end
        k, i = dec.raw_decode(text, i)  # key string
        while text[i] in _WS:
            i += 1
        i += 1  # ':'
        while text[i] in _WS:
            i += 1
        start = i
        _, i = dec.raw_decode(text, i)
        last_end = i
        if k == key:
            found = (start, i)


def detect_indent(text: str) -> str:
    m = re.search(r'^([ \t]+)"', text, re.M)
    return m.group(1) if m else "  "


def render_value(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False)  # compact, inline like other arrays


def apply_market_holidays(text: str, new_value: dict) -> str:
    span, last_end = _find_top_level_value_span(text, KEY)
    rendered = render_value(new_value)
    if span:
        return text[:span[0]] + rendered + text[span[1]:]
    nl = "\r\n" if "\r\n" in text else "\n"
    entry = f'{detect_indent(text)}"{KEY}": {rendered}'
    if last_end is None:  # empty object
        close = text.rindex("}")
        return text[:close].rstrip(_WS) + nl + entry + nl + text[close:]
    return text[:last_end] + "," + nl + entry + text[last_end:]


# ------------------------------------------------------------------ main

def load_risk(path: Path):
    try:
        text = path.read_bytes().decode("utf-8")
        doc = json.loads(text)
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise SyncError(f"cannot read valid JSON from {path}: {type(e).__name__}") from None
    if not isinstance(doc, dict):
        raise SyncError("risk.json must contain a JSON object")
    cur = doc.get(KEY, {})
    if not isinstance(cur, dict):
        raise SyncError(f"{KEY} must be an object")
    if set(cur) - {"NSE", "MCX"}:
        raise SyncError(f"{KEY} has keys other than NSE/MCX")
    for g, v in cur.items():
        if not isinstance(v, list) or not all(is_iso_date(x) for x in v):
            raise SyncError(f"existing {KEY}.{g} is not a list of valid dates")
    return text, doc, cur


def atomic_write(path: Path, data: bytes, backup: bytes) -> None:
    bak = path.with_name(path.name + ".bak")
    bak.write_bytes(backup)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp, path.stat().st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run(args) -> int:
    url = os.environ.get("OPENALGO_URL", "").strip()
    key = os.environ.get("OPENALGO_API_KEY", "").strip()
    if not url or not key:
        raise SyncError("OPENALGO_URL and OPENALGO_API_KEY must be set")
    path = Path(args.risk)
    text, _doc, cur = load_risk(path)
    mapped = map_holidays(fetch_holidays(url, key, args.year))

    new = dict(cur)
    added: dict[str, list[str]] = {}
    for g in ("NSE", "MCX"):
        old = list(cur.get(g, []))
        merged = sorted(set(old) | mapped[g])
        added[g] = [d for d in merged if d not in set(old)]
        if merged or g in cur:
            new[g] = merged
    changed = new != cur or KEY not in _doc

    if args.dry_run:
        for g in ("NSE", "MCX"):
            print(f"{g}: " + (", ".join(added[g]) if added[g] else "(nothing to add)"))
        return 0
    if not changed:
        print("marketHolidays already up to date; file not modified")
        return 0
    out = apply_market_holidays(text, new)
    json.loads(out)  # sanity: result must still be valid JSON
    atomic_write(path, out.encode("utf-8"), text.encode("utf-8"))
    print(f"updated {path}: added NSE={len(added['NSE'])} MCX={len(added['MCX'])}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Sync OpenAlgo holidays into risk.json")
    p.add_argument("--risk", required=True, help="path to risk.json")
    p.add_argument("--year", type=int, default=None, help="year (2020-2050); default: OpenAlgo's current year")
    p.add_argument("--dry-run", action="store_true", help="print additions, write nothing")
    args = p.parse_args(argv)
    raw_key = os.environ.get("OPENALGO_API_KEY", "")
    secrets = {k for k in (raw_key, raw_key.strip()) if k}
    try:
        return run(args)
    except SyncError as e:
        msg = str(e)
    except Exception as e:  # never leak a traceback (could echo request data)
        msg = f"unexpected {type(e).__name__}"
    for k in secrets:
        msg = msg.replace(k, "***")
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
