"""Owner-side edge tests for backup.sh / restore.sh (fake docker on PATH, no real Docker)."""
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
SECRET = "EDGE-SECRET-7c41e2b9"
TS = re.compile(r"^\d{8}T\d{6}Z$")
MLINE = re.compile(r"^([0-9a-f]{64}) [ *](.+)$")  # GNU text mode "  " or binary mode " *" (Windows)
# On Windows a bare "bash" can resolve to the WSL launcher in System32; use the one on PATH.
BASH = shutil.which("bash") or "bash"

STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ]; then
  if [ -n "${FAKE_COMPOSE_FAIL:-}" ]; then echo "cannot connect" >&2; exit 1; fi
  if [ -n "${FAKE_STACK_UP:-}" ]; then echo abc123; fi
  exit 0
fi
if [ "$1" = "run" ]; then
  host=""
  for a in "$@"; do
    case "$a" in *:/dst) host="${a%:/dst}";; esac
  done
  if [[ "$*" =~ /dst/([A-Za-z_]+)\.tgz ]] && [[ "$*" == *"tar czf"* ]]; then
    echo "fake-archive-${BASH_REMATCH[1]}" > "$host/${BASH_REMATCH[1]}.tgz"
  fi
  if [ -n "${FAKE_FAIL_VOL:-}" ] && [[ "$*" == *"_${FAKE_FAIL_VOL}:"* ]]; then exit 1; fi
fi
exit 0
"""

CP_STUB = r"""#!/usr/bin/env bash
last="${@: -1}"
case "$last" in *"$FAKE_CP_FAIL_SUFFIX") echo "cp: simulated failure" >&2; exit 1;; esac
for c in /usr/bin/cp /bin/cp; do [ -x "$c" ] && exec "$c" "$@"; done
exit 127
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
        (dep / n).write_text(f"{n} ORIGINAL {SECRET}\n")
    e = dict(os.environ)
    e["PATH"] = f"{bindir}{os.pathsep}{e['PATH']}"
    e["FAKE_DOCKER_LOG"] = str(tmp_path / "docker.log")
    e["TRADEDESK_DEPLOY_DIR"] = str(dep)
    for k in ("FAKE_STACK_UP", "KEEP", "FAKE_FAIL_VOL", "FAKE_COMPOSE_FAIL", "COMPOSE_PROJECT_NAME"):
        e.pop(k, None)
    return e, tmp_path, dep


def run(script, args, e):
    r = subprocess.run([BASH, str(DEPLOY / script), *map(str, args)],
                       capture_output=True, text=True, env=e)
    assert SECRET not in r.stdout + r.stderr, "file contents leaked to output"
    return r


def log(e):
    p = Path(e["FAKE_DOCKER_LOG"])
    return p.read_text() if p.exists() else ""


def ts_dirs(dest):
    return sorted(p.name for p in dest.iterdir() if p.is_dir() and TS.match(p.name))


def snapshot(d):
    return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}


def backup(e, dest):
    r = run("backup.sh", [dest], e)
    assert r.returncode == 0, r.stderr
    return dest / ts_dirs(dest)[-1]


def fake_old_backups(dest, n):
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for i in range(n):
        b = dest / f"2020010{i + 1}T000000Z"
        b.mkdir()
        (b / "MANIFEST.txt").write_text(f"good-{i}\n")
        out.append(b)
    return out


def write_manifest(b, extra_lines=()):
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}"
             for p in sorted(b.iterdir()) if p.is_file() and p.name != "MANIFEST.txt"]
    (b / "MANIFEST.txt").write_text("\n".join([*lines, *extra_lines]) + "\n", newline="\n")


# ---------------------------------------------------------------- KEEP

@pytest.mark.parametrize("keep", ["0", "-1", "abc", "1.5", "00"])
def test_keep_invalid_rejected(env, keep):
    e, tmp, _ = env
    dest = tmp / "dest"
    olds = fake_old_backups(dest, 3)
    before = snapshot(dest)
    e["KEEP"] = keep
    r = run("backup.sh", [dest], e)
    assert r.returncode == 2, (keep, r.returncode, r.stderr)
    assert "KEEP" in r.stderr
    assert snapshot(dest) == before
    assert ts_dirs(dest) == [b.name for b in olds]
    assert "run" not in log(e)


def test_keep_one_keeps_only_new(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    fake_old_backups(dest, 3)
    e["KEEP"] = "1"
    new = backup(e, dest)
    assert ts_dirs(dest) == [new.name]
    assert not new.name.startswith("2020")
    assert (new / "MANIFEST.txt").is_file()


# ---------------------------------------------------------------- failing backup

def test_failing_tar_midway_leaves_no_backup_and_prunes_nothing(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    fake_old_backups(dest, 3)
    before = snapshot(dest)
    e["KEEP"] = "2"
    e["FAKE_FAIL_VOL"] = "openalgo_strategies"  # 3rd volume; earlier archives already written
    for _ in range(5):
        r = run("backup.sh", [dest], e)
        assert r.returncode != 0
    assert snapshot(dest) == before
    assert ts_dirs(dest) == ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]
    assert not [p for p in dest.iterdir() if p.name.endswith(".partial")]
    assert log(e).count("_openalgo_db:/src:ro") == 5


def test_failing_last_volume_leaves_no_backup(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    e["FAKE_FAIL_VOL"] = "trade_mcp_data"
    r = run("backup.sh", [dest], e)
    assert r.returncode != 0
    assert list(dest.iterdir()) == []


# ---------------------------------------------------------------- retention

def test_retention_ignores_unrelated_entries(env):
    e, tmp, _ = env
    dest = tmp / "dest"
    fake_old_backups(dest, 2)
    unrelated_dirs = ["notes", "20200101", "20200101T000000Z.old", "20200101T000000Z-manual",
                      "2020010xT000000Z", "x20200101T000000Z"]
    for n in unrelated_dirs:
        (dest / n).mkdir()
        (dest / n / "keep").write_text("k")
    (dest / "20200104T000000Z").write_text("a file, not a dir")
    (dest / "README").write_text("r")
    e["KEEP"] = "1"
    new = backup(e, dest)
    assert ts_dirs(dest) == [new.name]
    for n in unrelated_dirs:
        assert (dest / n / "keep").read_text() == "k", n
    assert (dest / "20200104T000000Z").read_text() == "a file, not a dir"
    assert (dest / "README").is_file()


# ---------------------------------------------------------------- paths / prefix

def test_dest_with_spaces_backup_and_restore(env):
    e, tmp, dep = env
    dest = tmp / "my backups" / "dest dir"
    b = backup(e, dest)
    names = {p.name for p in b.iterdir()}
    # TM2-75: paper_bot_data is saved as a SQLite snapshot (paper_bot_data.db), not a .tgz.
    assert names == {f"{v}.tgz" for v in VOLS} | {"paper_bot_data.db", "env", "openalgo.env", "risk.json", "MANIFEST.txt"}
    for ln in (b / "MANIFEST.txt").read_text().splitlines():
        h, name = MLINE.match(ln).groups()
        assert hashlib.sha256((b / name).read_bytes()).hexdigest() == h
    (dep / ".env").write_text("changed")
    r = run("restore.sh", [b], e)
    assert r.returncode == 0, r.stderr
    assert "ORIGINAL" in (dep / ".env").read_text()


@posix_only
def test_dest_with_spaces_permissions(env):
    e, tmp, _ = env
    b = backup(e, tmp / "my backups" / "dest dir")
    assert stat.S_IMODE(b.stat().st_mode) == 0o700
    for p in b.iterdir():
        assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_compose_project_name_prefix(env):
    e, tmp, _ = env
    e["COMPOSE_PROJECT_NAME"] = "tradedesk-prod"
    b = backup(e, tmp / "dest")
    lg = log(e)
    for v in VOLS:
        assert f"tradedesk-prod_{v}:/src:ro" in lg
    assert "deploy_" not in lg
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    r = run("restore.sh", [b], e)
    assert r.returncode == 0, r.stderr
    lg = log(e)
    for v in VOLS:
        assert f"tradedesk-prod_{v}:/dst" in lg
    assert "deploy_" not in lg


# ---------------------------------------------------------------- restore verification

def _assert_refused_untouched(r, e, dep, before):
    assert r.returncode != 0
    assert snapshot(dep) == before
    assert not list(dep.glob("*.pre-restore"))
    assert " run " not in f" {log(e)} "


def test_restore_refuses_tampered_manifest_line(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    m = (b / "MANIFEST.txt").read_text().splitlines()
    h, name = MLINE.match(m[0]).groups()
    m[0] = m[0].replace(h, "0" * 64 if h != "0" * 64 else "1" * 64)
    (b / "MANIFEST.txt").write_text("\n".join(m) + "\n", newline="\n")
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


def test_restore_refuses_missing_archive(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    (b / "trade_mcp_data.tgz").unlink()
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


def test_restore_refuses_missing_manifest(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    (b / "MANIFEST.txt").unlink()
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


def test_restore_refuses_extra_file_not_in_manifest(env):
    """A restorable file planted in the backup without a MANIFEST entry must not be restored unverified."""
    e, tmp, dep = env
    (dep / ".env").unlink()
    b = backup(e, tmp / "dest")
    assert not (b / "env").exists()
    (b / "env").write_text("INJECTED=1\n")
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)
    assert not (dep / ".env").exists()


def test_restore_refuses_path_traversal_manifest_entry(env):
    e, tmp, dep = env
    dest = tmp / "dest"
    b = backup(e, dest)
    outside = dest / "outside.txt"
    outside.write_text("outside")
    h = hashlib.sha256(outside.read_bytes()).hexdigest()
    write_manifest(b, [f"{h}  ../outside.txt"])
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


def test_restore_refuses_absolute_path_manifest_entry(env):
    e, tmp, dep = env
    dest = tmp / "dest"
    b = backup(e, dest)
    outside = tmp / "abs.txt"
    outside.write_text("abs")
    h = hashlib.sha256(outside.read_bytes()).hexdigest()
    p = subprocess.run([BASH, "-c", 'cd "$1" && pwd', "_", str(tmp)], capture_output=True, text=True).stdout.strip()
    write_manifest(b, [f"{h}  {p}/abs.txt"])
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


# ---------------------------------------------------------------- --force / stack state

def test_force_bypasses_running_stack_and_skips_compose_probe(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    e["FAKE_STACK_UP"] = "1"
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    r = run("restore.sh", ["--force", b], e)
    assert r.returncode == 0, r.stderr
    assert "compose" not in log(e)
    assert all(f"tar xzf /src/{v}.tgz" in log(e) for v in VOLS)


def test_stack_down_restores_without_force(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    r = run("restore.sh", [b], e)
    assert r.returncode == 0, r.stderr
    assert "compose" in log(e)


def test_compose_probe_failure_refuses(env):
    """If docker compose ps itself fails the stack state is unknown: fail closed."""
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    e["FAKE_COMPOSE_FAIL"] = "1"
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b], e), e, dep, before)


def test_force_after_dir_is_not_silently_accepted_when_stack_up(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    e["FAKE_STACK_UP"] = "1"
    Path(e["FAKE_DOCKER_LOG"]).write_text("")
    before = snapshot(dep)
    _assert_refused_untouched(run("restore.sh", [b, "--force"], e), e, dep, before)


# ---------------------------------------------------------------- failure midway / .pre-restore

def test_restore_failing_volume_midway_leaves_files_untouched(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    (dep / ".env").write_text("current")
    before = snapshot(dep)
    e["FAKE_FAIL_VOL"] = "openalgo_keys"
    r = run("restore.sh", [b], e)
    assert r.returncode != 0
    assert snapshot(dep) == before
    assert not list(dep.glob("*.pre-restore"))


def test_restore_failing_file_copy_midway_keeps_original(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    for n in (".env", "openalgo.env", "risk.json"):
        (dep / n).write_text(f"current-{n}")
    cpbin = tmp / "cpbin"
    cpbin.mkdir()
    (cpbin / "cp").write_text(CP_STUB, newline="\n")
    (cpbin / "cp").chmod(0o755)
    e["PATH"] = f"{cpbin}{os.pathsep}{e['PATH']}"
    e["FAKE_CP_FAIL_SUFFIX"] = "openalgo.env"
    r = run("restore.sh", [b], e)
    assert r.returncode != 0
    # .env was handled before the failure: restored, original kept aside
    assert (dep / ".env.pre-restore").read_text() == "current-.env"
    assert "ORIGINAL" in (dep / ".env").read_text()
    # openalgo.env: the original must survive somewhere
    survivors = [p.read_text() for p in (dep / "openalgo.env", dep / "openalgo.env.pre-restore") if p.exists()]
    assert "current-openalgo.env" in survivors
    # risk.json was never reached
    assert (dep / "risk.json").read_text() == "current-risk.json"


def test_pre_restore_only_for_existing_files(env):
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    (dep / "risk.json").unlink()
    r = run("restore.sh", [b], e)
    assert r.returncode == 0, r.stderr
    assert not (dep / "risk.json.pre-restore").exists()
    assert (dep / "risk.json").is_file()
    assert (dep / ".env.pre-restore").is_file()


def test_repeated_restore_does_not_destroy_first_pre_restore(env):
    """'Before overwriting any existing file, move it to *.pre-restore' also covers an existing .pre-restore."""
    e, tmp, dep = env
    b = backup(e, tmp / "dest")
    (dep / ".env").write_text("pre-incident-original")
    assert run("restore.sh", [b], e).returncode == 0
    assert (dep / ".env.pre-restore").read_text() == "pre-incident-original"
    assert run("restore.sh", [b], e).returncode == 0
    contents = [p.read_text() for p in dep.iterdir() if p.name.startswith(".env")]
    assert "pre-incident-original" in contents


# ---------------------------------------------------------------- no contents in output

def test_no_secret_in_any_output(env):
    e, tmp, dep = env
    (dep / ".env").write_text(f"API_KEY={SECRET}\nOTHER={SECRET}\n")
    (dep / "risk.json").write_text(f'{{"note": "{SECRET}"}}\n')
    dest = tmp / "dest"
    b = backup(e, dest)            # run() asserts SECRET absent from stdout/stderr
    assert run("restore.sh", [b], e).returncode == 0
    (b / "env").write_text(f"tampered {SECRET}\n")
    assert run("restore.sh", [b], e).returncode != 0
    e["FAKE_FAIL_VOL"] = "openalgo_db"
    assert run("backup.sh", [dest], e).returncode != 0
    assert SECRET not in log(e)
