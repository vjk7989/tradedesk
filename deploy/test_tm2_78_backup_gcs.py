"""TM2-78: deploy/backup-gcs.sh (encrypted off-site backups to GCS).

The hard rule pinned here: nothing unencrypted is ever uploaded.

Shims on PATH (python shebang scripts, as in the TM2-75 tests):
- gcloud: logs argv and CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED, copies the file it is
  asked to upload to a capture dir; can fail on request;
- age: logs argv and whether its stdin held the plaintext sentinel; writes the real
  `age-encryption.org/v1` header plus a body that never contains stdin, or simulates failure,
  a bad header (raw plaintext), a truncated header or no output;
- tar (one test only): writes partial plaintext and exits 1, to prove pipefail is honoured;
- backup.sh via the test-only TRADEDESK_BACKUP_SH override: writes a fake backup dir holding
  SECRET_SENTINEL and a fake private key, or fails / produces zero or two dirs.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parent
SCRIPT = DEPLOY / "backup-gcs.sh"
BASH = shutil.which("bash") or "bash"
AGE_MAGIC = b"age-encryption.org/v1"
STAMP = "20261128T210000Z"
SENTINEL = "SECRET_SENTINEL"
# Fake key material: never valid keys, only recognisable strings.
PUBKEY = "age1" + "q" * 58
PRIVKEY = "AGE-SECRET-KEY-1" + "Q" * 58
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="shims are python shebang scripts")
pytestmark = posix_only

GCLOUD = r'''#!@PY@
import json, os, shutil, sys
argv = sys.argv[1:]
d = os.environ["FAKE_CAPTURE"]
os.makedirs(d, exist_ok=True)
n = len(os.listdir(d))
copied = None
if len(argv) >= 3 and os.path.isfile(argv[2]):
    copied = os.path.join(d, "upload%d" % n)
    shutil.copyfile(argv[2], copied)
with open(os.environ["FAKE_GCLOUD_LOG"], "a") as f:
    f.write(json.dumps({"argv": argv, "copy": copied,
                        "pcu": os.environ.get("CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED")}) + "\n")
sys.exit(1 if os.environ.get("FAKE_GCLOUD_FAIL") else 0)
'''

AGE = r'''#!@PY@
import hashlib, json, os, sys
argv = sys.argv[1:]
data = sys.stdin.buffer.read()
out = argv[argv.index("-o") + 1] if "-o" in argv else None
with open(os.environ["FAKE_AGE_LOG"], "a") as f:
    f.write(json.dumps({"argv": argv, "stdin_len": len(data),
                        "stdin_has_sentinel": b"SECRET_SENTINEL" in data}) + "\n")
mode = os.environ.get("FAKE_AGE_MODE", "ok")
body = b"\n-> X25519 fakestanza\n--- mac\n" + hashlib.sha256(data).hexdigest().encode() + b"\n"
if mode == "ok":
    open(out, "wb").write(b"age-encryption.org/v1" + body)
elif mode == "fail":          # partial (valid-looking) output, then failure
    open(out, "wb").write(b"age-encryption.org/v1\n-> X25519 part")
    sys.exit(1)
elif mode == "badheader":     # worst case: the "encryptor" emits the plaintext as-is
    open(out, "wb").write(data)
elif mode == "truncated":     # header cut short, exit 0
    open(out, "wb").write(b"age-encryption.org/")
elif mode == "nooutput":
    pass
sys.exit(0)
'''

TAR_FAIL = r'''#!@PY@
import sys
sys.stdout.buffer.write(b"./secret.env\0partial SECRET_SENTINEL")
sys.stdout.flush()
sys.exit(1)
'''

BACKUP = r'''#!@PY@
import json, os, sys
with open(os.environ["FAKE_BACKUP_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
dest = sys.argv[1]
mode = os.environ.get("FAKE_BACKUP_MODE", "ok")
def mk(name):
    b = os.path.join(dest, name)
    os.makedirs(b)
    open(os.path.join(b, "secret.env"), "w").write("API_KEY=SECRET_SENTINEL\n")
    open(os.path.join(b, "openalgo.env"), "w").write("KEY=@PRIV@\nSECRET_SENTINEL\n")
if mode == "zero":
    sys.exit(0)
mk("@STAMP@")
if mode == "two":
    mk("20261127T210000Z")
sys.exit(1 if mode == "fail" else 0)
'''


def _write_exe(path, text):
    path.write_text(text.replace("@PY@", sys.executable).replace("@PRIV@", PRIVKEY)
                    .replace("@STAMP@", STAMP), newline="\n")
    path.chmod(0o755)


def _base_path():
    """The caller's PATH without any dir that holds a real age or gcloud."""
    keep = []
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d and not any(os.access(os.path.join(d, x), os.X_OK) for x in ("age", "gcloud")):
            keep.append(d)
    return os.pathsep.join(keep)


@pytest.fixture
def env(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _write_exe(bindir / "gcloud", GCLOUD)
    _write_exe(bindir / "age", AGE)
    _write_exe(tmp_path / "fake-backup.sh", BACKUP)
    rcpt = tmp_path / "recipients.txt"
    rcpt.write_text(f"# offline key; this host never sees {PRIVKEY}\n{PUBKEY}\n")
    (tmp_path / "tmpdir").mkdir()
    e = {k: v for k, v in os.environ.items()
         if not k.startswith(("FAKE_", "BACKUP_", "AGE_", "CLOUDSDK_")) and k != "TRADEDESK_BACKUP_SH"}
    e.update(
        PATH=f"{bindir}{os.pathsep}{_base_path()}",
        TMPDIR=str(tmp_path / "tmpdir"),
        BACKUP_BUCKET="my-bucket",
        AGE_RECIPIENTS_FILE=str(rcpt),
        BACKUP_WORKDIR=str(tmp_path / "work"),
        TRADEDESK_BACKUP_SH=str(tmp_path / "fake-backup.sh"),
        FAKE_GCLOUD_LOG=str(tmp_path / "gcloud.log"),
        FAKE_AGE_LOG=str(tmp_path / "age.log"),
        FAKE_BACKUP_LOG=str(tmp_path / "backup.log"),
        FAKE_CAPTURE=str(tmp_path / "captured"),
    )
    return e, tmp_path


def _log(e, key):
    p = Path(e[key])
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


def gcloud_calls(e):
    return _log(e, "FAKE_GCLOUD_LOG")


def age_calls(e):
    return _log(e, "FAKE_AGE_LOG")


def backup_calls(e):
    return _log(e, "FAKE_BACKUP_LOG")


def assert_no_leak(r):
    for stream in (r.stdout, r.stderr):
        assert SENTINEL.encode() not in stream, stream
        assert b"AGE-SECRET-KEY" not in stream, stream
        # Only the public key may ever appear; the fake private key's body must not.
        assert PRIVKEY[16:].encode() not in stream, stream


def run(e, cwd=None):
    r = subprocess.run([BASH, str(SCRIPT)], capture_output=True, env=e, cwd=cwd)
    assert_no_leak(r)
    return r


def gcs_dirs(workdir):
    return sorted(p.name for p in Path(workdir).glob("tradedesk-gcs.*")) if Path(workdir).exists() else []


def assert_fail_fast(r, e):
    assert r.returncode == 2, (r.returncode, r.stderr)
    assert gcloud_calls(e) == []
    assert backup_calls(e) == []
    assert age_calls(e) == []
    assert gcs_dirs(e.get("BACKUP_WORKDIR") or "/nonexistent") == []


# ============================================================== 1) fail fast


@pytest.mark.parametrize("value", [None, ""])
def test_bucket_unset_or_empty(env, value):
    e, _ = env
    if value is None:
        del e["BACKUP_BUCKET"]
    else:
        e["BACKUP_BUCKET"] = value
    r = run(e)
    assert_fail_fast(r, e)
    assert b"BACKUP_BUCKET" in r.stderr


@pytest.mark.parametrize("value", ["gs://my-bucket", "my-bucket/sub"])
def test_bucket_not_bare_name(env, value):
    e, _ = env
    e["BACKUP_BUCKET"] = value
    assert_fail_fast(run(e), e)


@pytest.mark.parametrize("case", ["unset", "empty", "missing", "directory"])
def test_recipient_file_unset_or_missing(env, case):
    e, tmp = env
    if case == "unset":
        del e["AGE_RECIPIENTS_FILE"]
    elif case == "empty":
        e["AGE_RECIPIENTS_FILE"] = ""
    elif case == "missing":
        e["AGE_RECIPIENTS_FILE"] = str(tmp / "nope.txt")
    else:
        e["AGE_RECIPIENTS_FILE"] = str(tmp)
    assert_fail_fast(run(e), e)


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root can read mode 000 files")
def test_recipient_file_unreadable(env):
    e, _ = env
    p = Path(e["AGE_RECIPIENTS_FILE"])
    p.chmod(0)
    try:
        assert_fail_fast(run(e), e)
    finally:
        p.chmod(0o600)


@pytest.mark.parametrize("content", [
    "",                                                            # empty file
    "# only a comment\n\n",                                        # no age1 line
    "age1yubikey1" + "q" * 50 + "\n",                              # plugin recipient
    f"{PUBKEY}\nage1yubikey1" + "q" * 50 + "\n",                   # valid + plugin
    "age1tpm1" + "q" * 58 + "\n",                                  # another plugin form
    "hello world\n",                                               # junk
    f"{PUBKEY}\njunk\n",                                           # valid + junk
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host\n",           # ssh recipient (not plain age1)
    "age1" + "q" * 57 + "\n",                                      # too short
    "age1" + "b" * 58 + "\n",                                      # 'b' is not bech32
    f"  {PUBKEY}\n",                                               # leading spaces
    f"{PRIVKEY}\n",                                                # identity, not a recipient
], ids=["empty", "comment-only", "plugin", "valid+plugin", "plugin2", "junk", "valid+junk", "ssh",
        "short", "not-bech32", "indented", "identity"])
def test_recipient_file_bad_content(env, content):
    e, _ = env
    Path(e["AGE_RECIPIENTS_FILE"]).write_text(content)
    r = run(e)
    assert_fail_fast(r, e)


@pytest.mark.parametrize("tool", ["age", "gcloud", "both"])
def test_tool_missing(env, tool):
    e, tmp = env
    for t in (["age", "gcloud"] if tool == "both" else [tool]):
        (tmp / "bin" / t).unlink()
    r = run(e)
    assert_fail_fast(r, e)
    assert b"not installed" in r.stderr


@pytest.mark.parametrize("value", ["/", "//", "", "rel/dir", "./work"])
def test_workdir_unsafe_value(env, value):
    e, tmp = env
    e["BACKUP_WORKDIR"] = value
    cwd = tmp / "cwd"
    cwd.mkdir()
    r = run(e, cwd=cwd)
    assert r.returncode == 2, r.stderr
    assert gcloud_calls(e) == [] and backup_calls(e) == [] and age_calls(e) == []
    assert list(cwd.iterdir()) == [], "relative work dir must not be created"
    assert not list(Path("/").glob("tradedesk-gcs.*"))


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o711, 0o701], ids=oct)
def test_workdir_existing_not_700_refused_and_unchanged(env, mode):
    e, tmp = env
    w = tmp / "work"
    w.mkdir()
    w.chmod(mode)
    r = run(e)
    assert_fail_fast(r, e)
    assert stat.S_IMODE(w.stat().st_mode) == mode, "pre-existing work dir must keep its mode"
    assert list(w.iterdir()) == []


def test_workdir_owned_by_someone_else(env):
    e, _ = env
    other = Path("/root")
    try:
        st = other.stat()
    except OSError:
        pytest.skip("/root not stat-able")
    if not other.is_dir() or st.st_uid == os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        pytest.skip("need a mode-700 dir owned by another user (cannot chown here)")
    e["BACKUP_WORKDIR"] = str(other)
    r = run(e)
    assert r.returncode == 2, r.stderr
    assert gcloud_calls(e) == [] and backup_calls(e) == [] and age_calls(e) == []
    assert b"not owned" in r.stderr


def test_workdir_file_not_dir(env):
    e, tmp = env
    (tmp / "work").write_text("x")
    r = run(e)
    assert r.returncode == 2, r.stderr
    assert gcloud_calls(e) == [] and backup_calls(e) == []


# ============================================================== 2) success


def _assert_success(e, tmp, prefix="tradedesk"):
    r = run(e)
    assert r.returncode == 0, r.stderr
    calls = gcloud_calls(e)
    assert len(calls) == 1, calls
    c = calls[0]
    argv = c["argv"]
    dest = f"gs://{e['BACKUP_BUCKET']}/{prefix}/{STAMP}.tar.age"
    assert argv[:2] == ["storage", "cp"] and len(argv) == 4 and argv[3] == dest, argv
    assert "--no-clobber" not in argv and "-n" not in argv
    assert c["pcu"] == "False"
    src = Path(argv[2])
    work = Path(e["BACKUP_WORKDIR"])
    assert src.name == f"{STAMP}.tar.age"
    assert src.parent.name == "out" and src.parent.parent.parent == work
    assert src.parent.parent.name.startswith("tradedesk-gcs.")
    uploaded = Path(c["copy"]).read_bytes()
    assert uploaded.startswith(AGE_MAGIC)
    assert SENTINEL.encode() not in uploaded and b"AGE-SECRET-KEY" not in uploaded
    # The plaintext really went into age (and only into age).
    (a,) = age_calls(e)
    assert a["stdin_has_sentinel"] and a["stdin_len"] > 0
    assert a["argv"] == ["-R", e["AGE_RECIPIENTS_FILE"], "-o", str(src)], a
    assert backup_calls(e) == [[str(src.parent.parent / "plain")]]
    # Cleanup and work dir permissions.
    assert gcs_dirs(work) == []
    assert not src.parent.parent.exists()
    assert stat.S_IMODE(work.stat().st_mode) == 0o700
    assert dest.encode() in r.stdout
    return r


def test_success_new_workdir(env):
    e, tmp = env
    _assert_success(e, tmp)


def test_success_existing_700_workdir(env):
    e, tmp = env
    w = tmp / "work"
    w.mkdir()
    w.chmod(0o700)
    _assert_success(e, tmp)


def test_success_custom_prefix(env):
    e, tmp = env
    e["BACKUP_PREFIX"] = "prod/vm-1"
    _assert_success(e, tmp, prefix="prod/vm-1")


@pytest.mark.parametrize("prefix", ["/abs", "a/../b", "trail/", "sp ace", "a;b"])
def test_bad_prefix_fails_fast(env, prefix):
    e, _ = env
    e["BACKUP_PREFIX"] = prefix
    assert_fail_fast(run(e), e)


# ============================================================== 3) never unencrypted


def _assert_runtime_fail(r, e):
    assert r.returncode == 1, (r.returncode, r.stderr)
    assert gcloud_calls(e) == []
    assert not Path(e["FAKE_CAPTURE"]).exists() or not list(Path(e["FAKE_CAPTURE"]).iterdir())
    assert gcs_dirs(e["BACKUP_WORKDIR"]) == [], "temp dir (plaintext) left behind"


@pytest.mark.parametrize("mode", ["fail", "badheader", "truncated", "nooutput"])
def test_age_problem_never_uploads(env, mode):
    e, _ = env
    e["FAKE_AGE_MODE"] = mode
    r = run(e)
    _assert_runtime_fail(r, e)
    assert len(age_calls(e)) == 1


@pytest.mark.parametrize("mode", ["fail", "zero", "two"])
def test_backup_sh_problem_never_uploads(env, mode):
    e, _ = env
    e["FAKE_BACKUP_MODE"] = mode
    r = run(e)
    _assert_runtime_fail(r, e)
    assert age_calls(e) == []


def test_tar_fails_midpipe_pipefail_honoured(env):
    """tar emits partial plaintext then fails; age 'succeeds' with a valid header. Must not upload."""
    e, tmp = env
    _write_exe(tmp / "bin" / "tar", TAR_FAIL)
    r = run(e)
    _assert_runtime_fail(r, e)
    (a,) = age_calls(e)
    assert a["stdin_has_sentinel"], "the shim tar must have fed age (proves the failure is tar's status)"


def test_gcloud_failure_exit1_and_cleanup(env):
    e, _ = env
    e["FAKE_GCLOUD_FAIL"] = "1"
    r = run(e)
    assert r.returncode == 1, r.stderr
    (c,) = gcloud_calls(e)
    assert Path(c["copy"]).read_bytes().startswith(AGE_MAGIC)
    assert gcs_dirs(e["BACKUP_WORKDIR"]) == []


def _code_lines(text):
    out = []
    for line in text.splitlines():
        line = re.sub(r"(^|\s)#.*$", "", line).rstrip()
        if line.strip():
            out.append(line)
    return out


def test_static_single_upload_path():
    text = SCRIPT.read_text()
    code = _code_lines(text)
    m = re.search(r"^upload_encrypted\(\) \{\n(.*?)^\}\n", text, re.M | re.S)
    assert m, "upload_encrypted() not found"
    body = _code_lines(m.group(1))
    gl = [ln for ln in code if re.search(r"\bgcloud\b", ln)]
    in_body = [ln for ln in body if re.search(r"\bgcloud\b", ln)]
    outside = [ln for ln in gl if ln not in in_body]
    assert len(in_body) == 1, in_body
    assert len(outside) == 1 and "command -v gcloud" in outside[0], outside
    assert "storage cp" in in_body[0]
    # Inside the function the gcloud call comes after the magic check and the env export.
    i_g = next(i for i, ln in enumerate(body) if "gcloud" in ln)
    assert any("AGE_MAGIC" in ln and "die" in ln for ln in body[:i_g])
    assert any("CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False" in ln for ln in body[:i_g])
    # upload_encrypted is called exactly once, outside its own body.
    uses = [ln for ln in code if re.search(r"\bupload_encrypted\b", ln)]
    assert len(uses) == 2 and uses[0].startswith("upload_encrypted()"), uses
    # No other way off the box.
    for tool in ("gsutil", "curl", "wget", "rsync", "scp", "storage.googleapis", "eval"):
        assert not any(re.search(rf"\b{re.escape(tool)}\b", ln) for ln in code), tool
    assert "set -euo pipefail" in code


# ============================================================== 4) cleanup / sweep


def test_stale_sweep(env):
    e, tmp = env
    w = tmp / "work"
    w.mkdir()
    w.chmod(0o700)
    old = time.time() - 3 * 86400
    stale = w / "tradedesk-gcs.stale1"
    (stale / "plain").mkdir(parents=True)
    (stale / "plain" / "secret.env").write_text(SENTINEL)
    fresh = w / "tradedesk-gcs.fresh1"
    fresh.mkdir()
    other = w / "keepme"
    other.mkdir()
    oldfile = w / "tradedesk-gcs.notadir"
    oldfile.write_text("x")
    for p in (stale / "plain" / "secret.env", stale / "plain", stale, other, oldfile):
        os.utime(p, (old, old))
    r = run(e)
    assert r.returncode == 0, r.stderr
    assert not stale.exists()
    assert fresh.is_dir() and other.is_dir() and oldfile.is_file()
    assert gcs_dirs(w) == ["tradedesk-gcs.fresh1", "tradedesk-gcs.notadir"]


# ============================================================== 6) syntax / untouched scripts


def test_bash_n():
    r = subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("name", ["backup.sh", "restore.sh"])
def test_backup_restore_unchanged_vs_main(name):
    git = shutil.which("git")
    if git is None:
        pytest.skip("git not installed")
    ref = subprocess.run([git, "rev-parse", f"origin/main:deploy/{name}"], capture_output=True,
                         text=True, cwd=DEPLOY)
    if ref.returncode != 0:
        pytest.skip("origin/main not available")
    cur = subprocess.run([git, "hash-object", str(DEPLOY / name)], capture_output=True, text=True, cwd=DEPLOY)
    assert cur.returncode == 0, cur.stderr
    assert cur.stdout.strip() == ref.stdout.strip()
