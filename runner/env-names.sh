#!/bin/sh
# env, installed in $PAPERCLIP_SHIM_DIR (/usr/local/lib/paperclip-shims) and
# linked from /usr/local/bin, ahead of /usr/bin/env on PATH. Running a command
# (`env [OPTION]... [NAME=VALUE]... COMMAND [ARG]...`, which Paperclip's SSH
# driver uses for every run) passes through to /usr/bin/env unchanged, as do
# --help and --version. Listing the environment (no COMMAND) prints variable
# NAMES only, with /usr/bin/env's exit status: a run's environment holds its
# Paperclip API key and the agent's private key, and printing them ends the
# run at the gateway's scan gate. /usr/bin/env itself, `set`, `export -p`,
# `declare -p` and /proc/self/environ still show values; this only removes the
# common accident.
real=/usr/bin/env
has_cmd=
skip=
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case $arg in
    --help|--version) exec "$real" "$@" ;;
    --) ;;
    --u*=*|--c*=*) ;;
    --u*|--c*) skip=1 ;;     # --unset NAME, --chdir DIR (and abbreviations)
    --s*) has_cmd=1; break ;; # --split-string: the string is a command
    --*) ;;
    -) ;;
    -?*)
      # A group of short options: S starts a command; u or C takes the rest
      # of the group, or the next argument when the group ends with it.
      group=${arg#-}
      while [ -n "$group" ]; do
        c=${group%"${group#?}"}
        group=${group#?}
        case $c in
          S) has_cmd=1; break 2 ;;
          u|C) [ -z "$group" ] && skip=1; break ;;
        esac
      done
      ;;
    *=*) ;;
    *) has_cmd=1; break ;;
  esac
done
if [ "$has_cmd" = 1 ]; then
  exec "$real" "$@"
fi
# No command: list names. -0 keeps multi-line values (PEM keys) in one record.
tmp=$(mktemp) || exit 125
trap 'rm -f "$tmp"' EXIT
"$real" -0 "$@" >"$tmp"
rc=$?
sed -z 's/=.*//' "$tmp" | tr '\0' '\n' | LC_ALL=C sort
exit "$rc"
