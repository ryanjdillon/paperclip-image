#!/usr/bin/python3 -I
"""Check the runner's Nix store before any run can use it.

Called by the entrypoint before sshd starts. In single-user mode every run
owns the store and its database, so a run can rewrite a store path that later
runs reuse: a path is named after its build inputs, not its contents. A path
survives only if

- its contents match the hash in the database (nix store verify), and
- it is signed by cache.nixos.org (the image's nix.conf is the only trust
  source here; --sigs-needed 1 also overrides a planted `ultimate` flag), or
- it is a recursive sha256 fixed-output path whose verified NAR hash is the
  hash its name is computed from, or a flat sha256 fixed-output file whose
  contents hash to it. Nix treats every content-addressed path as trusted,
  but it only checks that the `ca` field reproduces the name, not that the
  contents match `ca`, so a run could edit a .drv, rewrite its NAR hash in
  the database and pass. Text paths (.drv files, builtins.toFile) are
  deleted outright: evaluation writes them again for free.

The database must have exactly the schema of a fresh Nix database (recorded
when the image is built): a planted trigger could otherwise re-register a
tampered path while paths are deleted. The keep set is fixed before anything
is deleted, and the store must end up as exactly that set.

Failing paths are deleted with everything that refers to them (unsigned paths
are local builds, rebuilt when needed). GC roots, profiles, logs and anything
else on the volume but the store and its database go too. If anything about
the check fails, the store is wiped; the exit status is non-zero, and the
runner does not start, only if the wipe itself fails. Logs counts only, never
paths or contents.
"""

import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

NIX = "/nix"
STORE = "/nix/store"
DB = "/nix/var/nix/db"
SCHEMA = "/usr/local/share/nix-store-check/schema.json"
STORE_NAME = re.compile(r"^[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$")
NIX32 = "0123456789abcdfghijklmnpqrsvwxyz"
GC_MB = int(os.environ.get("NIX_STORE_GC_MB", "40000"))

# Nix sees the image's config and nothing a run could have planted.
NIX_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": os.environ.get("HOME", "/home/node"),
    "NIX_CONF_DIR": "/etc/nix",
    "NIX_USER_CONF_FILES": "",
    "NIX_SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
}


class Wipe(Exception):
    """The store cannot be trusted or checked: empty it."""


def log(msg):
    print(f"nix-store-check: {msg}", file=sys.stderr, flush=True)


def nix(*args, stdin=None):
    return subprocess.run(list(args), env=NIX_ENV, input=stdin, capture_output=True,
                          text=True, check=False,
                          stdin=None if stdin is not None else subprocess.DEVNULL)


def remove(path):
    """Delete a file, symlink or tree without following symlinks. Every
    directory is made accessible first: store paths are read-only, and a run
    may have left a directory with no permissions at all."""
    if not stat.S_ISDIR(os.lstat(path).st_mode):
        os.unlink(path)
        return
    os.chmod(path, 0o700)
    with os.scandir(path) as entries:
        children = [e.path for e in entries]
    for child in children:
        remove(child)
    os.rmdir(path)


def real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False


def wipe(reason):
    """Move everything on the volume aside (instant); purge_trash() deletes it
    in the background. A failed move raises: the store must not stay in use."""
    os.chmod(NIX, 0o755)
    trash = tempfile.mkdtemp(dir=NIX, prefix=".trash-")
    for name in os.listdir(NIX):
        src = os.path.join(NIX, name)
        if src == trash or name.startswith(".trash-"):
            continue
        if real_dir(src):
            os.chmod(src, 0o700)  # moving a directory updates its "..".
        os.rename(src, os.path.join(trash, name))
    log(f"{reason}; store wiped")


def du_mb(path):
    total = 0
    for root, dirs, files in os.walk(path):  # does not follow symlinks
        for name in dirs + files:
            try:
                total += os.lstat(os.path.join(root, name)).st_blocks * 512
            except FileNotFoundError:
                pass
    return total // (1024 * 1024)


def nix32(digest):
    out = []
    for n in range((len(digest) * 8 + 4) // 5 - 1, -1, -1):
        b = n * 5
        i, j = b // 8, b % 8
        c = digest[i] >> j
        if i + 1 < len(digest):
            c |= digest[i + 1] << (8 - j)
        out.append(NIX32[c & 0x1F])
    return "".join(out)


def ca_ok(path, info, root=""):
    """Whether a content-addressed path's contents are bound to its name."""
    ca = info.get("ca") or ""
    if ca.startswith("fixed:r:sha256:"):
        # The NAR hash was checked against the contents by verify.
        algo, _, b64 = (info.get("narHash") or "").partition("-")
        return algo == "sha256" and nix32(base64.b64decode(b64)) == ca[len("fixed:r:sha256:"):]
    if ca.startswith("fixed:sha256:"):
        full = root + path
        if not stat.S_ISREG(os.lstat(full).st_mode):
            return False
        h = hashlib.sha256()
        with open(full, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return nix32(h.digest()) == ca[len("fixed:sha256:"):]
    return False


def schema(db_file):
    """The database's full schema (tables, indexes, triggers, views)."""
    conn = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        rows = conn.execute("select type, name, tbl_name, sql from sqlite_master").fetchall()
    finally:
        conn.close()
    return sorted([list(r) for r in rows], key=lambda r: [str(x) for x in r])


def listing():
    result = nix("nix", "path-info", "--json-format", "1", "--json", "--all")
    if result.returncode != 0:
        raise Wipe("the store database is unreadable")
    infos = json.loads(result.stdout)
    if not isinstance(infos, dict):
        raise Wipe("unexpected path-info output")
    return infos


def clean_volume():
    """Keep only /nix/store and /nix/var/nix/db, each a real directory at
    every level; everything else (roots, profiles, logs, planted files) goes.
    """
    for name in os.listdir(NIX):
        if name in ("store", "var") or name.startswith(".trash-"):
            continue
        remove(os.path.join(NIX, name))
    for path in (STORE, "/nix/var", "/nix/var/nix", DB):
        if os.path.lexists(path) and not real_dir(path):
            raise Wipe(f"{path} is not a directory")
    for parent, keep in (("/nix/var", "nix"), ("/nix/var/nix", "db")):
        if real_dir(parent):
            os.chmod(parent, 0o755)
            for name in os.listdir(parent):
                if name != keep:
                    remove(os.path.join(parent, name))
    if real_dir(DB):
        os.chmod(DB, 0o755)
        for name in os.listdir(DB):
            if not stat.S_ISREG(os.lstat(os.path.join(DB, name)).st_mode):
                raise Wipe("the store database holds a non-file")


def check():
    started = time.time()
    clean_volume()
    if not real_dir(DB):
        if os.path.lexists(STORE):
            raise Wipe("store without a database")
        return
    used = du_mb(NIX)
    if used > GC_MB:
        raise Wipe(f"store is {used} MiB (over {GC_MB})")
    with open(SCHEMA) as f:
        if schema(os.path.join(DB, "db.sqlite")) != json.load(f):
            raise Wipe("the store database's schema is not Nix's")

    # Nix exits 1 for a corrupt database as for a modified path, so the
    # database is read on its own first. This listing fixes the keep set.
    infos = listing()
    verify = nix("nix", "store", "verify", "--all", "--sigs-needed", "1")
    bad = set(re.findall(r"path '(/nix/store/[^']+)'", verify.stderr + verify.stdout))
    # 1 = a path was modified, 2 = a path is untrusted; anything else, or a
    # failure that names no path, means the check did not complete.
    if verify.returncode & ~3 or (verify.returncode and not bad):
        raise Wipe(f"verify failed (exit {verify.returncode})")
    bad |= {p for p, info in infos.items() if info.get("ca") and not ca_ok(p, info)}

    # Everything that refers to a failing path goes with it. Kept paths are
    # signed, and a signature covers the path's references, so the database
    # cannot hide a referrer that is kept.
    referrers = {}
    for path, info in infos.items():
        for ref in info.get("references") or []:
            if ref != path:
                referrers.setdefault(ref, set()).add(path)
    doomed, todo = set(), list(bad)
    while todo:
        path = todo.pop()
        if path not in doomed:
            doomed.add(path)
            todo.extend(referrers.get(path, ()))
    keep = set(infos) - doomed

    if doomed:
        deleted = nix("nix", "store", "delete", "--ignore-liveness", "--stdin",
                      stdin="".join(f"{p}\n" for p in sorted(doomed & set(infos))))
        if deleted.returncode != 0:
            raise Wipe(f"could not delete {len(doomed)} failing paths")

    # The store must now be exactly the keep set: nothing re-registered, and
    # no entry the database does not know (Nix ignores those until it needs
    # the name), including anything that is not a store path name.
    if not set(listing()) <= keep:
        raise Wipe("paths reappeared in the database while deleting")
    keep_names = {os.path.basename(p) for p in keep}
    extra = 0
    if real_dir(STORE):
        for name in os.listdir(STORE):
            if name not in keep_names or not STORE_NAME.match(name):
                remove(os.path.join(STORE, name))
                # .links is Nix's own hard-link directory: it recreates it
                # whenever it opens the store, so it is not counted.
                extra += name != ".links"
    log(f"{len(keep)} paths kept, {len(doomed)} failing paths deleted (with referrers), "
        f"{extra} unregistered entries removed, in {time.time() - started:.0f}s")


def purge_trash():
    """Delete what wipe() moved aside, now or from a start that died before
    finishing, in a detached process so sshd starts at once."""
    trash = [os.path.join(NIX, n) for n in os.listdir(NIX) if n.startswith(".trash-")]
    if trash:
        subprocess.Popen(
            [sys.executable, "-I", os.path.abspath(__file__), "--purge", *trash],
            stdin=subprocess.DEVNULL, start_new_session=True)


def build(db_root):
    """At image build: record a fresh database's schema, and check the hash
    formats this script relies on against this Nix (so a format change fails
    the build instead of deleting every fixed-output path at each start)."""
    store = f"local?root={db_root}"
    work = tempfile.mkdtemp()
    with open(os.path.join(work, "flat"), "w") as f:
        f.write("flat\n")
    os.mkdir(os.path.join(work, "tree"))
    with open(os.path.join(work, "tree", "file"), "w") as f:
        f.write("tree\n")
    flat = nix("nix", "store", "add-file", "--store", store, os.path.join(work, "flat"))
    tree = nix("nix", "store", "add-path", "--store", store, os.path.join(work, "tree"))
    text = nix("nix", "eval", "--store", store, "--raw", "--impure", "--expr",
               'builtins.toFile "text" "text"')
    for r in (flat, tree, text):
        if r.returncode != 0:
            raise SystemExit(f"self-test: nix failed: {r.stderr.strip()}")
    infos = json.loads(nix("nix", "path-info", "--store", store, "--json-format", "1",
                           "--json", "--all").stdout)
    flat_p, tree_p, text_p = (r.stdout.strip() for r in (flat, tree, text))
    assert infos[flat_p]["ca"].startswith("fixed:sha256:"), "flat ca format"
    assert infos[tree_p]["ca"].startswith("fixed:r:sha256:"), "recursive ca format"
    assert ca_ok(flat_p, infos[flat_p], db_root), "flat path not accepted"
    assert ca_ok(tree_p, infos[tree_p], db_root), "recursive path not accepted"
    assert not ca_ok(text_p, infos[text_p], db_root), "text path accepted"
    os.makedirs(os.path.dirname(SCHEMA), exist_ok=True)
    with open(SCHEMA, "w") as f:
        json.dump(schema(os.path.join(db_root, "nix/var/nix/db/db.sqlite")), f, indent=1)
    print("nix-store-check: self-test passed; schema recorded")


def main():
    if sys.argv[1:2] == ["--build"]:
        build(sys.argv[2])
        return 0
    if sys.argv[1:2] == ["--purge"]:
        for path in sys.argv[2:]:
            try:
                remove(path)
            except OSError as exc:
                log(f"could not delete a wiped store ({exc.strerror})")
        return 0
    try:
        try:
            check()
        except Wipe as reason:
            wipe(str(reason))
        except Exception as exc:  # noqa: BLE001 - any failure means wipe
            wipe(f"check failed ({type(exc).__name__})")
        purge_trash()
    except Exception as exc:  # noqa: BLE001 - only a failed wipe stops the runner
        log(f"wipe failed ({type(exc).__name__}); not starting")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
