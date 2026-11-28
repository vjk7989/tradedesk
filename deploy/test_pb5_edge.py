"""PB-5 edge tests: every writable mount in compose is writable by the image's runtime user.

Bugs from the first GCP deploy: bt-service /runs tmpfs was root-owned (EACCES on every backtest), and
openalgo.env (bind-mounted at /app/.env) was unreadable by the OpenAlgo uid (restart loop).

Rules checked statically (pyyaml only):
- tmpfs: no copy-up from the image, so the mount options must set uid= to the image user (or mode 1777).
- named volume: Docker copies the image dir (incl. ownership) into a fresh, empty volume, so the image
  must create the mount path and chown it to USER before the volume is first used.
- writable bind mount: the runbook must chown the host file to the container uid.
Docker checks skip when the daemon is not running.
"""
import re
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parent
ROOT = DEPLOY.parent
COMPOSE = DEPLOY / "docker-compose.yml"
ENV_EX = DEPLOY / ".env.example"
RUNBOOK = ROOT / "docs" / "vps-runbook.md"
OPENALGO_DOCKERFILE = ROOT / "vendor" / "openalgo" / "Dockerfile"

# Users that come from the base image rather than a useradd in our Dockerfile.
BASE_IMAGE_USERS = {"node": 1000, "root": 0}
# OpenAlgo upstream Dockerfile at the pinned commit f83592a: `useradd --uid 1000 appuser`, `USER appuser`
# (verified in coord/reports/PB-5.md). vendor/ is not part of this repo, so this documented value is
# used when vendor/openalgo/Dockerfile is absent.
OPENALGO_DOCUMENTED_UID = 1000


def compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def svc(name):
    return compose()["services"][name]


def _lines(dockerfile_text):
    # Join backslash continuations so multi-line RUNs parse as one instruction.
    return re.sub(r"\\\r?\n", " ", dockerfile_text).splitlines()


def runtime_user(dockerfile_text):
    """(uid, username) of the last USER in the final stage. Root if no USER."""
    stages = re.split(r"(?im)^\s*FROM\s", dockerfile_text)
    final = stages[-1]
    users = re.findall(r"(?im)^\s*USER\s+(\S+)", final)
    if not users:
        return 0, "root"
    name = users[-1].split(":")[0]
    if name.isdigit():
        return int(name), name
    for line in _lines(final):
        if re.search(r"\b(useradd|adduser)\b", line) and re.search(rf"\s{re.escape(name)}(\s|$|&&|;)", line):
            m = re.search(r"(?:-u|--uid)[ =](\d+)", line)
            if m:
                return int(m.group(1)), name
    if name in BASE_IMAGE_USERS:
        return BASE_IMAGE_USERS[name], name
    raise AssertionError(f"cannot resolve uid of USER {name}")


def chowned_dirs(dockerfile_text, user):
    """Paths in the final stage that are `chown`ed to `user` (name or uid)."""
    final = re.split(r"(?im)^\s*FROM\s", dockerfile_text)[-1]
    out = set()
    for m in re.finditer(r"chown\s+(?:-R\s+)?(\S+)\s+((?:/\S+\s*)+)", "\n".join(_lines(final))):
        owner = m.group(1).split(":")[0]
        if owner == user:
            out.update(p.rstrip(";&") for p in m.group(2).split())
    return out


def dockerfile_for(name):
    ctx = svc(name)["build"]["context"]
    return (DEPLOY / ctx / "Dockerfile").resolve()


def tmpfs_entries(service):
    t = service.get("tmpfs") or []
    return [t] if isinstance(t, str) else list(t)


def parse_tmpfs(entry):
    path, _, opts = entry.partition(":")
    kv = {}
    for o in filter(None, opts.split(",")):
        k, _, v = o.partition("=")
        kv[k] = v
    return path, kv


def named_volume_mounts(service, top_volumes):
    out = []
    for v in service.get("volumes") or []:
        if isinstance(v, str):
            parts = v.split(":")
            src, tgt = parts[0], parts[1]
            ro = len(parts) > 2 and "ro" in parts[2].split(",")
        else:
            if v.get("type") not in (None, "volume"):
                continue
            src, tgt, ro = v.get("source"), v.get("target"), bool(v.get("read_only"))
        if src in top_volumes and not ro:
            out.append((src, tgt))
    return out


def runbook_section(n):
    text = RUNBOOK.read_text(encoding="utf-8")
    m = re.search(rf"(?ms)^## {n}\. .*?(?=^## \d+\. |\Z)", text)
    assert m, f"runbook section {n} missing"
    return m.group(0)


# --- parser sanity (so a regex bug cannot pass the real checks vacuously) ---

def test_runtime_user_parser_cases():
    assert runtime_user("FROM x\nRUN useradd -r -u 1000 app\nUSER app\n") == (1000, "app")
    assert runtime_user("FROM x\nRUN useradd --uid 42 a && mkdir /d\nUSER a\n") == (42, "a")
    assert runtime_user("FROM x\nUSER 7\n") == (7, "7")
    assert runtime_user("FROM x\nRUN true\n") == (0, "root")
    # Only the final stage counts.
    assert runtime_user("FROM a AS b\nUSER 5\nFROM c\nUSER node\n") == (1000, "node")
    with pytest.raises(AssertionError):
        runtime_user("FROM x\nUSER ghost\n")


def test_parse_tmpfs_cases():
    assert parse_tmpfs("/runs") == ("/runs", {})
    assert parse_tmpfs("/runs:uid=1000,gid=1000,mode=0700") == ("/runs", {"uid": "1000", "gid": "1000", "mode": "0700"})


# --- AC1: bt-service /runs tmpfs uid matches the image user ---

def test_bt_runs_tmpfs_uid_matches_dockerfile_user():
    uid, _ = runtime_user(dockerfile_for("bt-service").read_text(encoding="utf-8"))
    assert uid != 0, "bt-service image should not run as root"
    entries = dict(parse_tmpfs(e) for e in tmpfs_entries(svc("bt-service")))
    assert "/runs" in entries, entries
    opts = entries["/runs"]
    assert opts.get("uid") == str(uid), f"/runs tmpfs uid={opts.get('uid')} but image user uid={uid}"
    assert opts.get("gid") == str(uid)


def test_bt_runs_tmpfs_mode_0700():
    opts = dict(parse_tmpfs(e) for e in tmpfs_entries(svc("bt-service")))["/runs"]
    assert opts.get("mode") == "0700", opts
    # Owner rwx, nothing for group/other.
    assert int(opts["mode"], 8) & 0o700 == 0o700 and int(opts["mode"], 8) & 0o077 == 0


def test_bt_runs_dir_env_points_at_tmpfs():
    s = svc("bt-service")
    env = s["environment"]
    assert env["BT_RUNS_DIR"] == "/runs"
    assert env["BT_RUNS_DIR"] in {parse_tmpfs(e)[0] for e in tmpfs_entries(s)}


def test_bt_runs_tmpfs_is_only_runs_entry():
    # A duplicate bare "/runs" entry would mount root-owned again.
    paths = [parse_tmpfs(e)[0] for e in tmpfs_entries(svc("bt-service"))]
    assert paths.count("/runs") == 1, paths


# --- AC2: every writable tmpfs / named volume is writable by the image user ---

OUR_SERVICES = [n for n, s in yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"].items()
                if "build" in s and not str(s["build"].get("context", "")).startswith("${")]


@pytest.mark.parametrize("name", OUR_SERVICES)
def test_every_tmpfs_owned_by_image_user(name):
    s = svc(name)
    uid, _ = runtime_user(dockerfile_for(name).read_text(encoding="utf-8"))
    for e in tmpfs_entries(s):
        path, opts = parse_tmpfs(e)
        if uid == 0:
            continue
        world_writable = opts.get("mode", "").lstrip("0") and int(opts["mode"], 8) & 0o002
        assert opts.get("uid") == str(uid) or world_writable, (
            f"{name}: tmpfs {path} uid={opts.get('uid', '0 (default)')} not writable by image uid {uid}")


@pytest.mark.parametrize("name", OUR_SERVICES)
def test_every_named_volume_precreated_and_chowned_in_image(name):
    """Fresh named volume inherits the image dir's owner; the image must chown the mount path to USER."""
    top = set((compose().get("volumes") or {}).keys())
    text = dockerfile_for(name).read_text(encoding="utf-8")
    uid, user = runtime_user(text)
    if uid == 0:
        return
    owned = chowned_dirs(text, user) | chowned_dirs(text, str(uid))
    for vol, tgt in named_volume_mounts(svc(name), top):
        assert tgt in owned, f"{name}: volume {vol} at {tgt} not chowned to {user} ({uid}) in Dockerfile; owned={owned}"


def test_paper_bot_data_writable_by_bot_user():
    text = dockerfile_for("paper-bot").read_text(encoding="utf-8")
    uid, user = runtime_user(text)
    assert (uid, user) == (10001, "bot")
    assert "/data" in chowned_dirs(text, user)
    s = svc("paper-bot")
    assert ("paper_bot_data", "/data") in named_volume_mounts(s, set(compose()["volumes"]))
    # paper-bot uses a named volume, not tmpfs: a tmpfs /data would need uid=10001.
    assert not [e for e in tmpfs_entries(s) if parse_tmpfs(e)[0] == "/data"]
    # DATA_DIR (image ENV) must point at the mounted path.
    assert re.search(r"(?m)^ENV .*DATA_DIR=/data\b", text)


def test_paper_bot_uid_differs_from_bt_uid_so_bt_options_not_copied_blindly():
    # Guard: if someone moves paper-bot /data to tmpfs by copying bt-service's options, uid=1000 is wrong.
    bt, _ = runtime_user(dockerfile_for("bt-service").read_text(encoding="utf-8"))
    pb, _ = runtime_user(dockerfile_for("paper-bot").read_text(encoding="utf-8"))
    assert bt != pb


def test_trade_mcp_data_writable_by_node_user():
    text = dockerfile_for("trade-mcp").read_text(encoding="utf-8")
    uid, user = runtime_user(text)
    assert (uid, user) == (1000, "node")
    assert "/data" in chowned_dirs(text, user)


def test_bt_runs_also_precreated_in_image():
    # Defence in depth: image dir is chowned too, so running without the compose tmpfs still works.
    text = dockerfile_for("bt-service").read_text(encoding="utf-8")
    _, user = runtime_user(text)
    assert "/runs" in chowned_dirs(text, user)


def test_no_service_has_bare_root_owned_tmpfs():
    for name, s in compose()["services"].items():
        for e in tmpfs_entries(s):
            path, opts = parse_tmpfs(e)
            if name in OUR_SERVICES and runtime_user(dockerfile_for(name).read_text(encoding="utf-8"))[0] == 0:
                continue
            assert opts, f"{name}: tmpfs {path} has no uid/mode options (root-owned 755 by default)"


# --- AC3: runbook section 5 chown after chmod, uid matches OpenAlgo image user ---

def openalgo_uid():
    if OPENALGO_DOCKERFILE.exists():
        return runtime_user(OPENALGO_DOCKERFILE.read_text(encoding="utf-8"))[0]
    # vendor/openalgo is not checked out in this repo/CI: fall back to the documented uid (see top).
    return OPENALGO_DOCUMENTED_UID


def test_runbook_s5_chowns_openalgo_env_after_chmod():
    sec = runbook_section(5)
    chmod = re.search(r"(?m)^chmod 600 .*\bopenalgo\.env\b", sec)
    chown = re.search(r"(?m)^sudo chown (\d+)(?::\d+)? openalgo\.env\s*$", sec)
    assert chmod, "chmod 600 openalgo.env missing from section 5"
    assert chown, "sudo chown <uid> openalgo.env missing from section 5"
    assert chmod.start() < chown.start(), "chown must come after chmod"
    # Both inside the same fenced block (so a copy-paste of the block runs both).
    between = sec[chmod.start():chown.start()]
    assert "```" not in between


def test_runbook_s5_chown_uid_matches_openalgo_image_user():
    m = re.search(r"(?m)^sudo chown (\d+)(?::\d+)? openalgo\.env", runbook_section(5))
    assert m and int(m.group(1)) == openalgo_uid()
    assert openalgo_uid() != 0


def test_runbook_s5_chown_after_openalgo_env_is_created():
    sec = runbook_section(5)
    cp = re.search(r"(?m)^cp \S+ openalgo\.env\s*$", sec)
    chown = re.search(r"(?m)^sudo chown \d+ openalgo\.env", sec)
    assert cp and chown and cp.start() < chown.start()


def test_runbook_s5_does_not_chown_deploy_env():
    # deploy/.env is read by compose on the host (operator), not by a container; chowning it to 1000 would
    # lock the operator out on hosts where the operator is not uid 1000.
    assert not re.search(r"(?m)^sudo chown \S+ .*(?<![\w.])\.env\b", runbook_section(5))


def test_runbook_s5_drops_unverified_note_and_explains_why():
    sec = runbook_section(5)
    assert "is unverified" not in sec
    assert re.search(r"uid 1000", sec) and "/app/.env" in sec


def test_openalgo_env_bind_is_writable_target():
    # Runbook says OpenAlgo writes keys back to /app/.env: the bind must not be read_only.
    binds = [v for v in svc("openalgo")["volumes"] if isinstance(v, dict) and v.get("target") == "/app/.env"]
    assert len(binds) == 1 and not binds[0].get("read_only")
    assert binds[0]["bind"]["create_host_path"] is False


# --- AC4: docker (skips without a daemon) ---

HAS_DOCKER = shutil.which("docker") is not None


def _daemon_up():
    return HAS_DOCKER and subprocess.run(["docker", "info"], capture_output=True).returncode == 0


DAEMON = _daemon_up()


def _compose(project, *args, timeout=900):
    return subprocess.run(
        ["docker", "compose", "-p", project, "-f", str(COMPOSE), "--env-file", str(ENV_EX), *args],
        capture_output=True, text=True, cwd=str(DEPLOY), timeout=timeout,
    )


@pytest.fixture
def project():
    p = f"pb5edge{uuid.uuid4().hex[:8]}"
    yield p
    _compose(p, "down", "-v", "--remove-orphans", timeout=120)


@pytest.mark.skipif(not DAEMON, reason="docker daemon not running")
def test_docker_bt_service_can_write_runs(project):
    r = _compose(project, "run", "--rm", "--no-deps", "bt-service", "sh", "-c",
                 "touch /runs/x && stat -c '%u %a' /runs && id -u")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.strip().splitlines()
    owner, mode = lines[-2].split()
    assert owner == lines[-1] == "1000"
    assert mode == "700"


@pytest.mark.skipif(not DAEMON, reason="docker daemon not running")
def test_docker_paper_bot_can_write_fresh_data_volume(project):
    r = _compose(project, "run", "--rm", "--no-deps", "--entrypoint", "sh", "paper-bot", "-c",
                 "touch /data/x && stat -c '%u' /data && id -u")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.strip().splitlines()
    assert lines[-2] == lines[-1] == "10001"
