"""TM2-75: paper_bot_data is backed up (WAL-safe snapshot) and every compose volume is classified.

a) guard: every named volume in docker-compose.yml is in backup.sh VOLUMES or EXCLUDED_VOLUMES
   (with a reason), and nothing is listed that compose does not define; plus proof the guard fires;
b) paper_bot_data / caddy_data specifics in backup.sh and restore.sh;
c) fake-docker shim on PATH: logs argv, maps named volumes to host dirs and really executes the
   alpine sh/tar commands and the inline Python (snapshot, integrity check) on the host;
d) the backup's inline snapshot snippet run for real against a WAL db with a concurrent writer;
e) a real docker round-trip (skipped when docker is not installed).
"""
import hashlib
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parent
BASH = shutil.which("bash") or "bash"
TS = re.compile(r"^\d{8}T\d{6}Z$")
CID = "cid123"
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="fake docker is a python shebang script")


# ============================================================== a) guard


def _bash_array(text, name):
    """Items of a top-level bash array `NAME=( ... )` (may span lines, may hold comments). None if absent."""
    m = re.search(rf"^{name}=\((.*?)\)\s*$", text, re.M | re.S)
    if m is None:
        return None
    return shlex.split(m.group(1), comments=True)


def compose_volumes(compose_text):
    return list((yaml.safe_load(compose_text).get("volumes") or {}).keys())


def classification_problems(compose_text, backup_text):
    """Return a list of problems; empty means every compose volume is classified exactly once."""
    problems = []
    declared = compose_volumes(compose_text)
    backed = _bash_array(backup_text, "VOLUMES")
    excluded_raw = _bash_array(backup_text, "EXCLUDED_VOLUMES")
    if backed is None:
        return ["backup.sh has no VOLUMES=(...) array"]
    if excluded_raw is None:
        problems.append("backup.sh has no EXCLUDED_VOLUMES=(...) array")
        excluded_raw = []
    excluded = []
    for item in excluded_raw:
        name, sep, reason = item.partition(":")
        if not sep or not reason.strip():
            problems.append(f"exclusion without a reason: {item!r}")
        excluded.append(name)
    for lst, label in ((backed, "VOLUMES"), (excluded, "EXCLUDED_VOLUMES")):
        for v in sorted({x for x in lst if lst.count(x) > 1}):
            problems.append(f"{v}: listed twice in {label}")
    for v in declared:
        n = (v in backed) + (v in excluded)
        if n == 0:
            problems.append(f"{v}: compose volume not classified (add to VOLUMES or EXCLUDED_VOLUMES)")
        elif n == 2:
            problems.append(f"{v}: in both VOLUMES and EXCLUDED_VOLUMES")
    for v in backed:
        if v not in declared:
            problems.append(f"{v}: in VOLUMES but not a compose volume")
    for v in excluded:
        if v not in declared:
            problems.append(f"{v}: in EXCLUDED_VOLUMES but not a compose volume")
    return problems


def _read(name):
    return (DEPLOY / name).read_text()


def test_every_compose_volume_classified():
    assert compose_volumes(_read("docker-compose.yml")), "parsed no compose volumes"
    assert classification_problems(_read("docker-compose.yml"), _read("backup.sh")) == []


def test_guard_fires_on_new_unclassified_compose_volume(tmp_path):
    text = _read("docker-compose.yml")
    assert len(re.findall(r"^volumes:\n", text, re.M)) == 1
    fake = tmp_path / "docker-compose.yml"
    fake.write_text(re.sub(r"^volumes:\n", "volumes:\n  fake_new_vol:\n", text, flags=re.M))
    assert "fake_new_vol" in compose_volumes(fake.read_text())
    problems = classification_problems(fake.read_text(), _read("backup.sh"))
    assert any(p.startswith("fake_new_vol:") and "not classified" in p for p in problems), problems


def test_guard_fires_on_listing_not_in_compose(tmp_path):
    text = _read("backup.sh")
    fake = tmp_path / "backup.sh"
    fake.write_text(re.sub(r"^VOLUMES=\(", "VOLUMES=(ghost_vol ", text, count=1, flags=re.M))
    problems = classification_problems(_read("docker-compose.yml"), fake.read_text())
    assert "ghost_vol: in VOLUMES but not a compose volume" in problems, problems
    fake.write_text(text.replace("EXCLUDED_VOLUMES=(\n", 'EXCLUDED_VOLUMES=(\n  "phantom_vol:gone"\n', 1))
    problems = classification_problems(_read("docker-compose.yml"), fake.read_text())
    assert "phantom_vol: in EXCLUDED_VOLUMES but not a compose volume" in problems, problems


def test_guard_fires_on_empty_reason_and_double_listing(tmp_path):
    text = _read("backup.sh")
    assert '"caddy_data:' in text
    no_reason = re.sub(r'"caddy_data:[^"]*"', '"caddy_data:  "', text)
    problems = classification_problems(_read("docker-compose.yml"), no_reason)
    assert any("exclusion without a reason" in p and "caddy_data" in p for p in problems), problems
    both = text.replace('"openalgo_tmp:', '"openalgo_db:', 1)
    problems = classification_problems(_read("docker-compose.yml"), both)
    assert "openalgo_db: in both VOLUMES and EXCLUDED_VOLUMES" in problems, problems
    assert any(p.startswith("openalgo_tmp:") and "not classified" in p for p in problems), problems


# ============================================================== b) specifics


def test_paper_bot_data_backed_up_and_caddy_data_excluded_with_reason():
    b = _read("backup.sh")
    assert "paper_bot_data" in _bash_array(b, "VOLUMES")
    reasons = dict(x.partition(":")[::2] for x in _bash_array(b, "EXCLUDED_VOLUMES"))
    assert reasons.get("caddy_data", "").strip(), reasons
    assert re.search(r'^SNAPSHOT_VOL="paper_bot_data"$', b, re.M)


def test_restore_volume_list_matches_backup_and_uses_snapshot_path():
    r = _read("restore.sh")
    assert _bash_array(r, "VOLUMES") == _bash_array(_read("backup.sh"), "VOLUMES")
    assert re.search(r'^SNAPSHOT_VOL="paper_bot_data"$', r, re.M)
    assert '[ -f "$BDIR/$vol.db" ]' in r
    assert "paper.db.new" in r


# ============================================================== c) fake-docker shim

SHIM = r'''#!@PY@
"""Fake docker: log argv as JSON, map named volumes to $FAKE_VOL_ROOT/<name>, run commands for real."""
import json, os, re, subprocess, sys
argv = sys.argv[1:]
with open(os.environ["FAKE_DOCKER_LOG"], "a") as f:
    f.write(json.dumps(argv) + "\n")
root = os.environ["FAKE_VOL_ROOT"]
up = bool(os.environ.get("FAKE_BOT_UP"))

def vol(name):
    p = os.path.join(root, name)
    os.makedirs(p, exist_ok=True)
    return p

def py(code, data_dir=None):
    env = dict(os.environ)
    if data_dir:
        env["DATA_DIR"] = data_dir
    return subprocess.run([sys.executable, "-c", code], env=env).returncode

cmd = argv[0]
if cmd == "compose":
    i, prefix = 1, None
    while argv[i] in ("-p", "-f"):
        if argv[i] == "-p":
            prefix = argv[i + 1]
        i += 2
    sub, rest = argv[i], argv[i + 1:]
    if sub == "ps":
        if "--status" in rest:
            if up: print(@CID@)
        elif os.environ.get("FAKE_STACK_UP"):
            print("abc123")
        sys.exit(0)
    if sub in ("exec", "run"):
        if os.environ.get("FAKE_SNAP_FAIL"):
            sys.stdout.write("partial-garbage")
            sys.exit(1)
        code = rest[rest.index("-c") + 1]
        sys.exit(py(code, vol((prefix or "deploy") + "_paper_bot_data")))
    sys.exit(0)
if cmd == "ps":
    if up: print(@CID@)
    sys.exit(0)
if cmd in ("stop", "start"):
    sys.exit(0)
if cmd == "run":
    mounts, i = {}, 1
    while argv[i].startswith("-"):
        if argv[i] == "-v":
            parts = argv[i + 1].split(":")
            mounts[parts[1]] = parts[0] if parts[0].startswith("/") else vol(parts[0])
            i += 2
        else:
            i += 1
    image, rest = argv[i], argv[i + 1:]
    sub = lambda s: re.sub(r"(?<![\w.])/(src|dst)(?!\w)", lambda m: mounts["/" + m.group(1)], s)
    rest = [sub(a) for a in rest]
    if image.startswith("python"):
        sys.exit(py(rest[rest.index("-c") + 1]))
    if image == "alpine":
        if rest[:2] == ["sh", "-c"]:
            script = rest[2]
            if os.environ.get("FAKE_CP_FAIL") and "paper.db.new" in script:
                with open(os.path.join(mounts["/dst"], "paper.db.new"), "wb") as f:
                    f.write(b"half-written")
                sys.stderr.write("cp: write error: No space left on device\n")
                sys.exit(1)
            # Not root here: neutralise chown (still visible in the log).
            script = re.sub(r"chown \S+ ", "true ", script)
            sys.exit(subprocess.run(["sh", "-c", script]).returncode)
        sys.exit(subprocess.run(rest).returncode)
    sys.exit(0)
sys.exit(0)
'''


@pytest.fixture
def shim(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    d = bindir / "docker"
    d.write_text(SHIM.replace("@PY@", sys.executable).replace("@CID@", repr(CID)), newline="\n")
    d.chmod(0o755)
    dep = tmp_path / "deploydir"
    dep.mkdir()
    (dep / "risk.json").write_text("{}\n")
    vols = tmp_path / "vols"
    vols.mkdir()
    e = {k: v for k, v in os.environ.items()
         if not k.startswith("FAKE_") and k not in ("KEEP", "COMPOSE_PROJECT_NAME")}
    e["PATH"] = f"{bindir}{os.pathsep}{e['PATH']}"
    e["FAKE_DOCKER_LOG"] = str(tmp_path / "docker.log")
    e["FAKE_VOL_ROOT"] = str(vols)
    e["TRADEDESK_DEPLOY_DIR"] = str(dep)
    return e, tmp_path, vols


def calls(e):
    p = Path(e["FAKE_DOCKER_LOG"])
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def clear_log(e):
    Path(e["FAKE_DOCKER_LOG"]).write_text("")


def sh(script, args, e):
    return subprocess.run([BASH, str(DEPLOY / script), *map(str, args)], capture_output=True, env=e)


def make_wal_db(path, n):
    """Create paper.db in WAL mode with n rows left in the WAL; return the open connection."""
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path, check_same_thread=False)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA wal_autocheckpoint=0")
    c.execute("CREATE TABLE trades(id INTEGER PRIMARY KEY, sym TEXT, pad TEXT)")
    c.executemany("INSERT INTO trades(sym, pad) VALUES(?, ?)", [("BTCUSD", "x" * 200)] * n)
    c.commit()
    assert Path(f"{path}-wal").stat().st_size > 0
    return c


def count_rows(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return c.execute("SELECT count(*) FROM trades").fetchone()[0]
    finally:
        c.close()


def ts_dirs(dest):
    return [p for p in dest.iterdir() if TS.match(p.name)] if dest.exists() else []


def snapshot_calls(cs):
    return [c for c in cs if c[0] == "compose" and ("exec" in c or "run" in c)]


def write_manifest(b):
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}"
             for p in sorted(b.iterdir()) if p.name != "MANIFEST.txt"]
    (b / "MANIFEST.txt").write_text("\n".join(lines) + "\n", newline="\n")


def do_backup(e, tmp, vols, n=300, prefix="deploy"):
    conn = make_wal_db(vols / f"{prefix}_paper_bot_data" / "paper.db", n)
    try:
        r = sh("backup.sh", [tmp / "dest"], e)
    finally:
        conn.close()
    assert r.returncode == 0, r.stderr.decode()
    (b,) = ts_dirs(tmp / "dest")
    return b


@posix_only
@pytest.mark.parametrize("prefix", [None, "tradedesk-prod"])
def test_backup_bot_running_uses_exec_with_prefix(shim, prefix):
    e, tmp, vols = shim
    e["FAKE_BOT_UP"] = "1"
    if prefix:
        e["COMPOSE_PROJECT_NAME"] = prefix
    p = prefix or "deploy"
    b = do_backup(e, tmp, vols, n=321, prefix=p)
    cs = snapshot_calls(calls(e))
    assert len(cs) == 1, cs
    c = cs[0]
    assert c[:3] == ["compose", "-p", p], c
    i = c.index("exec")
    assert c[i:i + 5] == ["exec", "-T", "paper-bot", "python", "-c"], c
    assert not any("--no-deps" in x for x in calls(e))
    probes = [x for x in calls(e) if x[0] == "compose" and "ps" in x]
    assert probes and all(x[:3] == ["compose", "-p", p] for x in probes), probes
    # The snapshot really came from the WAL db (the rows were only in -wal).
    assert count_rows(b / "paper_bot_data.db") == 321
    assert "paper_bot_data.db" in (b / "MANIFEST.txt").read_text()


@posix_only
def test_backup_bot_stopped_uses_run_no_deps(shim):
    e, tmp, vols = shim
    b = do_backup(e, tmp, vols, n=50)
    cs = snapshot_calls(calls(e))
    assert len(cs) == 1, cs
    c = cs[0]
    assert c[:3] == ["compose", "-p", "deploy"], c
    i = c.index("run")
    assert c[i:i + 7] == ["run", "--rm", "--no-deps", "-T", "paper-bot", "python", "-c"], c
    assert not any("exec" in x for x in calls(e))
    assert count_rows(b / "paper_bot_data.db") == 50


@posix_only
@pytest.mark.parametrize("how", ["forced", "no_db"])
def test_snapshot_failure_fails_backup_and_removes_partial(shim, how):
    e, tmp, vols = shim
    dest = tmp / "dest"
    if how == "forced":
        e["FAKE_BOT_UP"] = "1"
        e["FAKE_SNAP_FAIL"] = "1"
        make_wal_db(vols / "deploy_paper_bot_data" / "paper.db", 10).close()
    # how == "no_db": real snippet, volume has no paper.db -> sqlite cannot open it.
    r = sh("backup.sh", [dest], e)
    assert r.returncode != 0
    assert snapshot_calls(calls(e)), "snapshot was never attempted"
    assert list(dest.iterdir()) == [], [p.name for p in dest.iterdir()]


def _old_volume(vols, prefix="deploy"):
    v = vols / f"{prefix}_paper_bot_data"
    v.mkdir(parents=True, exist_ok=True)
    for n in ("paper.db", "paper.db-wal", "paper.db-shm"):
        (v / n).write_bytes(f"OLD-{n}".encode())
    return v


def _paper_steps(cs):
    """Label the docker calls that belong to the paper_bot_data restore, in order."""
    out = []
    for c in cs:
        s = " ".join(c)
        if c[0] == "run" and "python:3.12-slim" in c:
            out.append("verify")
        elif c[0] == "ps":
            out.append("probe")
        elif c[0] in ("stop", "start"):
            out.append(f"{c[0]} {' '.join(c[1:])}")
        elif c[0] == "run" and "paper.db.new" in s:
            out.append("cleanup" if c[-3:] == ["rm", "-f", "/dst/paper.db.new"] else "swap")
    return out


@posix_only
def test_restore_bad_integrity_aborts_before_stop(shim):
    e, tmp, vols = shim
    b = do_backup(e, tmp, vols)
    (b / "paper_bot_data.db").write_bytes(b"this is not a sqlite database" * 100)
    write_manifest(b)
    v = _old_volume(vols)
    before = {p.name: p.read_bytes() for p in v.iterdir()}
    e["FAKE_BOT_UP"] = "1"
    clear_log(e)
    r = sh("restore.sh", ["--force", b], e)
    assert r.returncode != 0
    assert b"integrity_check" in r.stderr
    assert _paper_steps(calls(e)) == ["verify"], calls(e)
    assert not any(c[0] in ("stop", "start", "ps") for c in calls(e))
    assert {p.name: p.read_bytes() for p in v.iterdir()} == before


@posix_only
@pytest.mark.parametrize("bot_up", [True, False])
def test_restore_copy_failure_keeps_old_db_and_restarts_bot(shim, bot_up):
    e, tmp, vols = shim
    b = do_backup(e, tmp, vols)
    v = _old_volume(vols)
    if bot_up:
        e["FAKE_BOT_UP"] = "1"
    e["FAKE_CP_FAIL"] = "1"
    clear_log(e)
    r = sh("restore.sh", ["--force", b], e)
    assert r.returncode != 0
    assert b"old paper.db kept" in r.stderr
    want = ["verify", "probe", f"stop {CID}", "swap", "cleanup", f"start {CID}"]
    if not bot_up:
        want = [s for s in want if CID not in s]
    assert _paper_steps(calls(e)) == want, calls(e)
    # Old db untouched, half-written .new removed; nothing ever rm'd paper.db itself.
    assert (v / "paper.db").read_bytes() == b"OLD-paper.db"
    assert (v / "paper.db-wal").read_bytes() == b"OLD-paper.db-wal"
    assert not (v / "paper.db.new").exists()
    for c in calls(e):
        assert not re.search(r"rm -f[^&]*/dst/paper\.db(\s|$)", " ".join(c)), c


@posix_only
@pytest.mark.parametrize("bot_up", [True, False])
def test_restore_success_sequence(shim, bot_up):
    e, tmp, vols = shim
    b = do_backup(e, tmp, vols, n=77)
    v = _old_volume(vols)
    if bot_up:
        e["FAKE_BOT_UP"] = "1"
    clear_log(e)
    r = sh("restore.sh", ["--force", b], e)
    assert r.returncode == 0, r.stderr.decode()
    want = ["verify", "probe", f"stop {CID}", "swap", f"start {CID}"]
    if not bot_up:
        want = [s for s in want if CID not in s]
    assert _paper_steps(calls(e)) == want, calls(e)
    probe = next(c for c in calls(e) if c[0] == "ps")
    assert probe == ["ps", "-q", "--filter", "name=^deploy[-_]paper-bot[-_]"]
    swap = next(c for c in calls(e) if c[0] == "run" and "paper.db.new" in " ".join(c))
    assert "deploy_paper_bot_data:/dst" in swap
    script = swap[-1]
    steps = ["cp /src/paper_bot_data.db /dst/paper.db.new", "chown 10001:10001", "chmod 600 /dst/paper.db.new",
             "mv -f /dst/paper.db.new /dst/paper.db", "rm -f /dst/paper.db-wal /dst/paper.db-shm"]
    pos = [script.find(s) for s in steps]
    assert -1 not in pos and pos == sorted(pos), (script, pos)
    assert (v / "paper.db").read_bytes() == (b / "paper_bot_data.db").read_bytes()
    assert sorted(p.name for p in v.iterdir()) == ["paper.db"]  # before opening it (WAL creates -shm)
    assert count_rows(v / "paper.db") == 77
    assert b"restored volume deploy_paper_bot_data" in r.stdout


# ============================================================== d) real WAL snapshot


def pysnap():
    m = re.search(r"^PYSNAP='(.*?)'$", _read("backup.sh"), re.M | re.S)
    assert m, "backup.sh has no PYSNAP='...' snippet"
    return m.group(1)


def _run_snap(data_dir, tmpdir, out):
    env = dict(os.environ, DATA_DIR=str(data_dir), TMPDIR=str(tmpdir))
    with open(out, "wb") as f:
        return subprocess.run([sys.executable, "-c", pysnap()], stdout=f, stderr=subprocess.PIPE, env=env)


def test_snapshot_snippet_wal_only_rows_exact(tmp_path):
    data, tmpd = tmp_path / "data", tmp_path / "tmp"
    tmpd.mkdir()
    conn = make_wal_db(data / "paper.db", 4000)
    try:
        r = _run_snap(data, tmpd, tmp_path / "snap.db")
    finally:
        conn.close()
    assert r.returncode == 0, r.stderr.decode()
    assert count_rows(tmp_path / "snap.db") == 4000
    assert list(tmpd.iterdir()) == []


def test_snapshot_snippet_with_concurrent_writer(tmp_path):
    data, tmpd = tmp_path / "data", tmp_path / "tmp"
    tmpd.mkdir()
    conn = make_wal_db(data / "paper.db", 20000)
    batch = 10
    stop = threading.Event()
    committed = []

    def writer():
        w = sqlite3.connect(data / "paper.db", timeout=30)
        w.execute("PRAGMA busy_timeout=5000")
        while not stop.is_set():
            w.executemany("INSERT INTO trades(sym, pad) VALUES(?, ?)", [("ETHUSD", "y" * 200)] * batch)
            w.commit()
            committed.append(batch)
        w.close()

    t = threading.Thread(target=writer)
    t.start()
    try:
        while not committed:
            time.sleep(0.001)
        before = 20000 + sum(committed)
        r = _run_snap(data, tmpd, tmp_path / "snap.db")
    finally:
        stop.set()
        t.join()
        conn.close()
    after = 20000 + sum(committed)
    assert r.returncode == 0, r.stderr.decode()
    n = count_rows(tmp_path / "snap.db")
    assert before <= n <= after, (before, n, after)
    # Transaction-consistent: whole batches only, ids contiguous.
    assert (n - 20000) % batch == 0
    c = sqlite3.connect(tmp_path / "snap.db")
    assert c.execute("SELECT max(id) FROM trades").fetchone()[0] == n
    c.close()
    assert after > before, "writer made no progress during the snapshot"
    assert list(tmpd.iterdir()) == []


def test_snapshot_snippet_failure_leaves_no_temp_file(tmp_path):
    data, tmpd = tmp_path / "data", tmp_path / "tmp"
    data.mkdir()
    tmpd.mkdir()
    r = _run_snap(data, tmpd, tmp_path / "snap.db")  # no paper.db
    assert r.returncode != 0
    assert list(tmpd.iterdir()) == []


# ============================================================== e) real docker round-trip

POPULATE = r"""
import sqlite3, time
c = sqlite3.connect("/data/paper.db")
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY, sym TEXT)")
c.execute("CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, note TEXT)")
c.executemany("INSERT INTO trades(sym) VALUES(?)", [("BTCUSD",)] * 1234)
c.executemany("INSERT INTO decisions(note) VALUES(?)", [("hold",)] * 567)
c.commit()
open("/data/ready", "w").close()
while True:
    time.sleep(3600)  # keep the connection open so the rows stay in the WAL
"""

COUNT = ("import sqlite3; c=sqlite3.connect('/data/paper.db'); "
         "print(c.execute('PRAGMA integrity_check').fetchone()[0], "
         "c.execute('select count(*) from trades').fetchone()[0], "
         "c.execute('select count(*) from decisions').fetchone()[0])")


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not installed")
def test_docker_round_trip(tmp_path):
    tag = uuid.uuid4().hex[:8]
    src_proj, dst_proj = f"tm275src{tag}", f"tm275dst{tag}"
    dep = tmp_path / "deploy"
    dep.mkdir()
    compose = {
        "services": {"paper-bot": {
            "image": "python:3.12-slim",
            "command": ["python", "-c", POPULATE],
            "environment": {"DATA_DIR": "/data"},
            "volumes": ["paper_bot_data:/data"],
        }},
        "volumes": {"paper_bot_data": {}},
    }
    (dep / "docker-compose.yml").write_text(yaml.safe_dump(compose))
    vols = [v for v in _bash_array(_read("backup.sh"), "VOLUMES")]
    base = {k: v for k, v in os.environ.items() if k not in ("COMPOSE_PROJECT_NAME", "KEEP")}
    base["TRADEDESK_DEPLOY_DIR"] = str(dep)
    dc = ["docker", "compose", "-f", str(dep / "docker-compose.yml")]

    def ok(cmd, **kw):
        r = subprocess.run(cmd, capture_output=True, text=True, **kw)
        assert r.returncode == 0, (cmd, r.stdout, r.stderr)
        return r.stdout

    try:
        ok([*dc, "-p", src_proj, "up", "-d"])
        for _ in range(120):
            if subprocess.run([*dc, "-p", src_proj, "exec", "-T", "paper-bot", "test", "-f", "/data/ready"]).returncode == 0:
                break
            time.sleep(1)
        else:
            pytest.fail("paper-bot never populated paper.db")
        assert ok([*dc, "-p", src_proj, "exec", "-T", "paper-bot", "test", "-s", "/data/paper.db-wal"]) == ""

        r = subprocess.run([BASH, str(DEPLOY / "backup.sh"), str(tmp_path / "dest")], capture_output=True,
                           text=True, env={**base, "COMPOSE_PROJECT_NAME": src_proj})
        assert r.returncode == 0, r.stderr
        (b,) = ts_dirs(tmp_path / "dest")
        assert (b / "paper_bot_data.db").stat().st_size > 0

        r = subprocess.run([BASH, str(DEPLOY / "restore.sh"), "--force", str(b)], capture_output=True,
                           text=True, env={**base, "COMPOSE_PROJECT_NAME": dst_proj})
        assert r.returncode == 0, r.stderr
        assert f"restored volume {dst_proj}_paper_bot_data" in r.stdout

        out = ok(["docker", "run", "--rm", "-v", f"{dst_proj}_paper_bot_data:/data", "python:3.12-slim",
                  "python", "-c", COUNT]).split()
        assert out == ["ok", "1234", "567"], out
        owner = ok(["docker", "run", "--rm", "-v", f"{dst_proj}_paper_bot_data:/data", "alpine",
                    "stat", "-c", "%u:%g %a", "/data/paper.db"]).strip()
        assert owner == "10001:10001 600", owner
        ls = ok(["docker", "run", "--rm", "-v", f"{dst_proj}_paper_bot_data:/data", "alpine", "ls", "/data"]).split()
        assert "paper.db.new" not in ls
    finally:
        for p in (src_proj, dst_proj):
            subprocess.run([*dc, "-p", p, "down", "-v", "--remove-orphans", "-t", "1"], capture_output=True)
            ids = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={p}"],
                                 capture_output=True, text=True).stdout.split()
            if ids:
                subprocess.run(["docker", "rm", "-f", *ids], capture_output=True)
            subprocess.run(["docker", "volume", "rm", "-f", *[f"{p}_{v}" for v in vols]], capture_output=True)
        # Backup files may be root-owned on some hosts; let pytest's tmp cleanup cope.
