#!/bin/sh
# /usr/local/bin/env, ahead of /usr/bin/env on PATH. Running a command
# (`env [OPTION]... [NAME=VALUE]... COMMAND [ARG]...`, which Paperclip's SSH
# driver uses for every run) passes through to /usr/bin/env unchanged. Listing
# the environment (no COMMAND) prints variable NAMES only: a run's environment
# holds its Paperclip API key and the agent's private key, and printing them
# ends the run at the gateway's scan gate. /usr/bin/env itself, `set`,
# `export -p`, `declare -p` and /proc/self/environ still show values; this only
# removes the common accident.
real=/usr/bin/env
has_cmd=
skip=
for arg in "$@"; do
  if [ -n "$skip" ]; then skip=; continue; fi
  case $arg in
    -u|-C|--unset|--chdir) skip=1 ;;
    -S*|--split-string|--split-string=*) has_cmd=1; break ;;
    -*) ;;
    *=*) ;;
    *) has_cmd=1; break ;;
  esac
done
if [ "$has_cmd" = 1 ]; then
  exec "$real" "$@"
fi
# No command: list names. -0 keeps multi-line values (PEM keys) on one record.
"$real" -0 "$@" | sed -z 's/=.*//' | tr '\0' '\n' | LC_ALL=C sort
