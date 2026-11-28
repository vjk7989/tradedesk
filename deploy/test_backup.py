"""Tests for backup.sh / restore.sh using a fake docker stub. No real Docker."""
import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parent
VOLS = ["openalgo_db", "openalgo_log", "openalgo_strategies", "openalgo_keys", "trade_mcp_data"]
SECRET = "SECRET-MARKER-9f3a1c"
MLINE = re.compile(r"^([0-9a-f]{64}) [ *](.+)$")
BASH = shutil.which("bash") or "bash"
TS = re.compile(r"^\d{8}T\d{6}Z$")

STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ]; then
  if [ -n "${FAKE_STACK_UP:-}" ]; then echo abc123; fi
  exit 0
fi
if [ "$1" = "run" ]; then
  if [ -n "${FAKE_DOCKER_FAIL:-}" ]; then exit 1; fi
  host=""; prev=""
  for a in "$@"; do
    case "$a" in *:/dst) host="${a%:/dst}";; esac
  done
  if [[ "$*" =~ /dst/([A-Za-z_]+)\.tgz ]] && [[ "$*" == *"tar czf"* ]]; then
    echo "fake-archive-${BASH_REMATCH[1]}" > "$host/${BASH_REMATCH[1]}.tgz"
  fi
fi
exit 0
"""

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="posix permissions")


@pytest.fixture
def env(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    d = bindir / "docker"
    d.write_text(STUB, newline="\n")
    d.chmod(0o755)
    dep = tmp_path / "deploy"
    dep.mkdir()
    for n in (".env", "openalgo.env", "risk.json"):
        (dep / n).write_text(f"{n} {SECRET}\n")
    e = dict(os.environ)
    e["PATH"] = f"{bindir}{os.pathsep}{e['PATH']}"
    e["FAKE_DOCKER_LOG"] = str(tmp_path / "docker.log")
    e["TRADEDESK_DEPLOY_DIR"] = str(dep)
    e.pop("FAKE_STACK_UP", None)
    e.pop("KEEP", None)
    e.pop("FAKE_DOCKER_FAIL", None)
    return e, tmp_path, dep


def run(script, args, e):
    r = subprocess.run([BASH, str(DEPLOY / script), *map(str, args)],
                       capture_output=True, text=True, env=e)
    assert SECRET not in r.stdout + r.stderr
    return r


def do_backup(e, tmp):
    dest = tmp / "dest"
    r = run("backup.sh", [dest], e)
    assert r.returncode == 0, r.stderr
    dirs = [p for p in dest.iterdir() if TS.match(p.name)]
    return dest, sorted(dirs)


def test_layout_and_manifest(env):
    e, tmp, _ = env
    _, dirs = do_backup(e, tmp)
    assert len(dirs) == 1
    b = dirs[0]
    names = {p.name for p in b.iterdir()}
    # TM2-75: paper_bot_data is saved as a SQLite snapshot (paper_bot_data.db), not a .tgz.
    assert names == {f"{v}.tgz" for v in VOLS} | {"paper_bot_data.db", "env", "openalgo.env", "risk.json", "MANIFEST.txt"}
    lines = (b / "MANIFEST.txt").read_text().splitlines()
    assert len(lines) == len(names) - 1
    for ln in lines:
        h, name = MLINE.match(ln).groups()
        assert hashlib.sha256((b / name).read_bytes()).hexdigest() == h
    assert "deploy_openalgo_db:/src:ro" in Path(e["FAKE_DOCKER_LOG"]).read_text()


@posix_only
def test_permissions(env):
    e, tmp, _ = env
    _, dirs = do_backup(e, tmp)
    assert stat.S_IMODE(dirs[0].stat().st_mode) == 0o700
    for p in dirs[0].iterdir():
        assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_retention(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    for i in range(15):
        (dest / f"2020010{i // 10}T0{i % 10}0000Z").mkdir(parents=True)
    (dest / "keepme").mkdir()
    r = run("backup.sh", [dest], e)
    assert r.returncode == 0, r.stderr
    dirs = [p for p in dest.iterdir() if TS.match(p.name)]
    assert len(dirs) == 14
    assert (dest / "keepme").is_dir()
    assert not (dest / "20200100T000000Z").exists()


def make_backup(e, tmp):
    _, dirs = do_backup(e, tmp)
    return dirs[0]


def test_restore_refuses_on_tamper(env):
    e, tmp, dep = env
    b = make_backup(e, tmp)
    (b / "risk.json").write_text("tampered")
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = {p.name: p.read_text() for p in dep.iterdir()}
    r = run("restore.sh", [b], e)
    assert r.returncode != 0
    assert {p.name: p.read_text() for p in dep.iterdir()} == before
    assert Path(e["FAKE_DOCKER_LOG"]).read_text() == ""


def test_restore_refuses_on_missing_file(env):
    e, tmp, dep = env
    b = make_backup(e, tmp)
    (b / "openalgo_db.tgz").unlink()
    assert run("restore.sh", [b], e).returncode != 0
    assert not list(dep.glob("*.pre-restore"))


def test_restore_refuses_when_stack_up(env):
    e, tmp, dep = env
    b = make_backup(e, tmp)
    e["FAKE_STACK_UP"] = "1"
    r = run("restore.sh", [b], e)
    assert r.returncode != 0
    assert r.stderr.strip()
    assert not list(dep.glob("*.pre-restore"))
    r = run("restore.sh", ["--force", b], e)
    assert r.returncode == 0, r.stderr


def test_restore_pre_restore_and_volumes(env):
    e, tmp, dep = env
    b = make_backup(e, tmp)
    (dep / ".env").write_text("changed-after-backup")
    r = run("restore.sh", [b], e)
    assert r.returncode == 0, r.stderr
    for n in (".env", "openalgo.env", "risk.json"):
        assert (dep / f"{n}.pre-restore").exists()
        assert SECRET in (dep / n).read_text()
    assert (dep / ".env.pre-restore").read_text() == "changed-after-backup"
    log = Path(e["FAKE_DOCKER_LOG"]).read_text()
    for v in VOLS:
        assert f"deploy_{v}:/dst" in log and f"tar xzf /src/{v}.tgz" in log


def test_failed_backup_leaves_nothing(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    for i in range(14):
        (dest / f"20200101T0000{i:02d}Z").mkdir(parents=True)
    e["FAKE_DOCKER_FAIL"] = "1"
    r = run("backup.sh", [dest], e)
    assert r.returncode != 0
    names = sorted(p.name for p in dest.iterdir())
    assert len(names) == 14 and all(TS.match(n) for n in names)


def test_keep_zero_rejected(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    e["KEEP"] = "0"
    r = run("backup.sh", [dest], e)
    assert r.returncode == 2
    assert not dest.exists() or not list(dest.iterdir())


@posix_only
@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root ignores modes")
def test_retention_failure_keeps_new_backup(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    old = dest / "20200101T000000Z"
    locked = old / "locked"
    locked.mkdir(parents=True)
    (locked / "f").write_text("x")
    locked.chmod(0o500)
    e["KEEP"] = "1"
    try:
        r = run("backup.sh", [dest], e)
        new = [p for p in dest.iterdir() if TS.match(p.name) and p != old]
        assert len(new) == 1
        assert (new[0] / "MANIFEST.txt").is_file()
        assert not list(dest.glob(".*.partial"))
    finally:
        locked.chmod(0o700)
