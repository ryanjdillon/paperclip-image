#!/bin/sh
# printenv, beside env-names.sh. With no names (or only -0/--null), variable
# NAMES only; with names, "NAME set" or "NAME unset" instead of the value (exit
# 1 if any is unset, like printenv). A variable set to the empty string counts
# as set. See env-names.sh for why.
names=
for arg in "$@"; do
  case $arg in
    --help|--version) exec /usr/bin/printenv "$@" ;;
    -*) ;;
    *) names=1 ;;
  esac
done
if [ -z "$names" ]; then
  exec "$(dirname "$0")/env"
fi
rc=0
for name in "$@"; do
  case $name in -*) continue ;; esac
  if /usr/bin/printenv "$name" >/dev/null 2>&1; then
    echo "$name set"
  else
    echo "$name unset"
    rc=1
  fi
done
exit "$rc"
