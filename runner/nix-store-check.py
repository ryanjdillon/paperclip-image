#!/usr/bin/env python3
"""Check the runner's Nix store before any run can use it.

Called by the entrypoint before sshd starts; a non-zero exit stops the runner
(fail closed). In single-user mode every run owns the store and its database,
so a run can rewrite a store path that later runs reuse: a path is named after
its build inputs, not its contents. A path survives only if

- its contents match the hash in the database (nix store verify), and
- it is signed by cache.nixos.org (the image's nix.conf is the only trust
  source here; --sigs-needed 1 also overrides a planted `ultimate` flag), or
- it is a recursive sha256 fixed-output path whose recorded NAR hash is the
  hash its name is computed from, or a flat sha256 fixed-output file whose
  contents hash to it. Nix treats every content-addressed path as trusted,
  but it only checks that the `ca` field reproduces the name, not that the
  contents match `ca`, so a run could edit a .drv, rewrite its NAR hash in
  the database and pass. Text paths (.drv files, builtins.toFile) are
  deleted outright: evaluation writes them again for free.

Failing paths are deleted with everything that refers to them (unsigned paths
are local builds, rebuilt when needed). GC roots, profiles, logs and anything
else on the volume but the store and its database go too. If the check cannot
complete, the store is wiped. Logs counts only, never paths or contents.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time

NIX = "/nix"
STORE = "/nix/store"
DB = "/nix/var/nix/db"
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


def nix(*args, check=True):
    return subprocess.run(list(args), env=NIX_ENV, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, check=check)


def remove(path):
    """Delete a file, symlink or tree without following symlinks. Store paths
    are read-only, so directories are made writable as the walk goes."""
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(path)
        return

    def retry(func, p, _exc):
        os.chmod(os.path.dirname(p), 0o700)
        if os.path.isdir(p) and not os.path.islink(p):
            os.chmod(p, 0o700)
        func(p)

    os.chmod(path, 0o700)
    shutil.rmtree(path, onerror=retry)


def real_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except FileNotFoundError:
        return False


def wipe(reason):
    """Move everything on the volume aside (instant), then delete it in the
    background. A failed move is fatal: the store must not stay in use."""
    trash = os.path.join(NIX, f".trash-{os.getpid()}-{int(time.time())}")
    os.mkdir(trash)
    for name in os.listdir(NIX):
        if name.startswith(".trash-"):
            continue
        src = os.path.join(NIX, name)
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


def sri_to_nix32(sri):
    algo, _, b64 = sri.partition("-")
    return algo, nix32(base64.b64decode(b64))


def ca_ok(path, info):
    """Whether a content-addressed path's contents are bound to its name."""
    ca = info.get("ca") or ""
    if ca.startswith("fixed:r:sha256:"):
        # The NAR hash was checked against the contents by verify.
        return sri_to_nix32(info.get("narHash", "")) == ("sha256", ca[len("fixed:r:sha256:"):])
    if ca.startswith("fixed:sha256:"):
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode):
            return False
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return nix32(h.digest()) == ca[len("fixed:sha256:"):]
    return False


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
            for name in os.listdir(parent):
                if name != keep:
                    remove(os.path.join(parent, name))
    # The database's own files (db.sqlite, its WAL, the schema and locks) must
    # be plain files, not links to somewhere else.
    if real_dir(DB):
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

    # Nix exits 1 for a corrupt database as for a modified path, so the
    # database is read on its own first.
    listing = nix("nix", "path-info", "--json-format", "1", "--json", "--all", check=False)
    if listing.returncode != 0:
        raise Wipe("the store database is unreadable")
    infos = json.loads(listing.stdout)

    verify = nix("nix", "store", "verify", "--all", "--sigs-needed", "1", check=False)
    bad = set(re.findall(r"path '(/nix/store/[^']+)'", verify.stderr + verify.stdout))
    # 1 = a path was modified, 2 = a path is untrusted; anything else, or a
    # failure that names no path, means the check did not complete.
    if verify.returncode & ~3 or (verify.returncode and not bad):
        raise Wipe(f"verify failed (exit {verify.returncode})")
    bad |= {p for p, info in infos.items() if info.get("ca") and not ca_ok(p, info)}

    deleted = 0
    if bad:
        closure = nix("nix-store", "--query", "--referrers-closure", *sorted(bad), check=False)
        doomed = sorted(set(closure.stdout.split()) | bad)
        if closure.returncode != 0:
            raise Wipe("could not list referrers of failing paths")
        if nix("nix-store", "--delete", "--ignore-liveness", *doomed, check=False).returncode != 0:
            raise Wipe(f"could not delete {len(doomed)} failing paths")
        deleted = len(doomed)

    # Entries the database does not know (Nix ignores them until it needs
    # that name), including anything that is not a store path name.
    listing = nix("nix", "path-info", "--all", check=False)
    if listing.returncode != 0:
        raise Wipe("the store database is unreadable after deleting")
    valid = {os.path.basename(p) for p in listing.stdout.split()}
    extra = 0
    if real_dir(STORE):
        for name in os.listdir(STORE):
            if name not in valid or not STORE_NAME.match(name):
                remove(os.path.join(STORE, name))
                extra += 1
    log(f"{len(valid)} paths kept, {deleted} failing paths deleted (with referrers), "
        f"{extra} unregistered entries removed, in {time.time() - started:.0f}s")


def purge_trash():
    """Delete what wipe() moved aside, now or from a start that died before
    finishing, in a detached process so sshd starts at once."""
    trash = [os.path.join(NIX, n) for n in os.listdir(NIX) if n.startswith(".trash-")]
    if trash:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--purge", *trash],
            stdin=subprocess.DEVNULL, start_new_session=True)


def main():
    if sys.argv[1:2] == ["--purge"]:
        for path in sys.argv[2:]:
            try:
                remove(path)
            except OSError as exc:
                log(f"could not delete a wiped store: {exc.strerror}")
        return 0
    try:
        try:
            check()
        except Wipe as reason:
            wipe(str(reason))
        purge_trash()
    except Exception as exc:  # noqa: BLE001 - any failure stops the runner
        log(f"check failed ({type(exc).__name__}); not starting")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
