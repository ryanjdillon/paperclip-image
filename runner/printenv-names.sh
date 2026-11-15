#!/bin/sh
# /usr/local/bin/printenv: with no arguments, variable NAMES only; with names,
# "NAME set" or "NAME unset" instead of the value (exit 1 if any is unset, like
# printenv). See env-names.sh for why.
if [ "$#" -eq 0 ]; then
  exec /usr/local/bin/env
fi
rc=0
for name in "$@"; do
  case $name in -*) continue ;; esac
  case $name in
    ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) echo "$name unset"; rc=1; continue ;;
  esac
  if eval "[ \"\${$name+set}\" = set ]"; then
    echo "$name set"
  else
    echo "$name unset"
    rc=1
  fi
done
exit "$rc"
