#!/bin/sh
# Check the runner's Nix store before any run can use it (called by the
# entrypoint, before sshd). In single-user mode every run owns the store and
# its database, so a run can rewrite a store path that later runs reuse. Every
# valid path must be signed by cache.nixos.org (the image's nix.conf is the
# only trust source here) or be content-addressed, and its contents must match
# the recorded hash; anything else is deleted, with whatever refers to it.
# Unsigned paths are local builds, cheap to rebuild. If the check itself
# cannot run (a corrupt database), the store is wiped.
#
# Logs counts only, never paths or contents.
set -u

# Nix sees the image's config and nothing a run could have planted.
nixenv() {
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" \
    NIX_CONF_DIR=/etc/nix NIX_USER_CONF_FILES= \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt "$@"
}

# Moves everything aside at once and deletes it in the background; store
# paths are read-only, so they are made writable first.
wipe() {
  trash=/nix/.trash-$$-$(date +%s)
  mkdir "$trash"
  for entry in /nix/* /nix/.[!.]*; do
    case "$entry" in /nix/.trash-*|'/nix/*'|'/nix/.[!.]*') continue ;; esac
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ -L "$entry" ] || chmod u+w "$entry" 2>/dev/null || true
    mv "$entry" "$trash/"
  done
  echo "nix-store-check: $1; store wiped" >&2
}

started=$(date +%s)

# Only the store and Nix's state belong on the volume; a planted symlink in
# their place means wipe.
for entry in /nix/* /nix/.[!.]*; do
  case "$entry" in
    /nix/store|/nix/var|/nix/.trash-*|'/nix/*'|'/nix/.[!.]*') ;;
    *) chmod -R u+w "$entry" 2>/dev/null; rm -rf "$entry" ;;
  esac
done
if [ -L /nix/store ] || [ -L /nix/var ]; then
  wipe "a store directory is a symlink"
elif [ ! -d /nix/var/nix/db ]; then
  # No database: nothing in the store is registered.
  [ ! -e /nix/store ] || wipe "store without a database"
else
  # No GC roots or profiles survive a start: a planted root must not keep
  # anything alive, and nothing here needs one.
  rm -rf /nix/var/nix/gcroots /nix/var/nix/profiles /nix/var/nix/temproots
  # Optimisation hard links; not needed, and a way to share inodes.
  if [ -d /nix/store/.links ]; then
    chmod -R u+w /nix/store/.links 2>/dev/null; rm -rf /nix/store/.links
  fi

  used=$(du -sm /nix 2>/dev/null | cut -f1)
  if [ "${used:-0}" -gt "${NIX_STORE_GC_MB:-40000}" ]; then
    # With no roots, collecting garbage empties the store.
    wipe "store is ${used} MiB (over ${NIX_STORE_GC_MB:-40000})"
  else
    valid=$(mktemp)
    report=$(mktemp)
    if ! nixenv nix path-info --all >/dev/null 2>&1; then
      # Nix exits 1 for a corrupt database as for a modified path, so the
      # database is read on its own first.
      wipe "the store database is unreadable"
    else
      nixenv nix store verify --all --sigs-needed 1 >"$report" 2>&1
      status=$?
      bad=$(sed -nE "s#.*path '(/nix/store/[^']+)'.*#\1#p" "$report" | sort -u)
      # 1 = a path was modified, 2 = a path is untrusted; anything else, or a
      # failure that names no path, means the check did not complete.
      if [ $((status & ~3)) -ne 0 ] || { [ "$status" -ne 0 ] && [ -z "$bad" ]; }; then
        wipe "verify failed (exit $status)"
      else
        if [ -n "$bad" ]; then
          # shellcheck disable=SC2086
          doomed=$(nixenv nix-store --query --referrers-closure $bad 2>/dev/null | sort -u)
          count=$(printf '%s\n' "$doomed" | grep -c .)
          # shellcheck disable=SC2086
          if [ "$count" -eq 0 ] || ! nixenv nix-store --delete --ignore-liveness $doomed >/dev/null 2>&1; then
            wipe "could not delete $count failing paths"
          else
            echo "nix-store-check: deleted $count paths (unsigned, modified, or referring to one)" >&2
          fi
        fi
        # Directories in the store that the database does not know: Nix
        # ignores them until it needs that name; delete them now.
        # (Not a pipeline: a failed listing must not read as an empty one.)
        if [ -d /nix/store ] && nixenv nix path-info --all >"$report" 2>/dev/null \
          && sort -u "$report" >"$valid"; then
          extra=0
          for p in $(find /nix/store -mindepth 1 -maxdepth 1 ! -name '.*' | sort -u | comm -23 - "$valid"); do
            chmod -R u+w "$p" 2>/dev/null; rm -rf "$p"; extra=$((extra + 1))
          done
          [ "$extra" -eq 0 ] || echo "nix-store-check: deleted $extra unregistered entries" >&2
          echo "nix-store-check: $(grep -c . "$valid") paths verified in $(( $(date +%s) - started ))s" >&2
        fi
      fi
    fi
    rm -f "$valid" "$report"
  fi
fi

# Leftovers of a wipe, now or from a start that died mid-delete.
(
  for t in /nix/.trash-*; do
    [ -e "$t" ] || continue
    chmod -R u+w "$t" 2>/dev/null || true
    rm -rf "$t" || echo "nix-store-check: could not delete $t" >&2
  done
) &
