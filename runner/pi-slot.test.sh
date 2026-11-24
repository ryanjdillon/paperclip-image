#!/bin/sh
# Build-time tests for the argument changes in pi-slot.sh (DIL-994). The
# Dockerfile runs this with the wrapper's real pi replaced by a stub that
# prints each argument as [arg], one line per run:
#   pi-slot.test.sh <wrapper> <extension path>
set -eu

wrapper=$1
ext=$2
fail=0

check() {
  want=$1
  shift
  got=$(PI_SLOTS_FILE=/nonexistent "$wrapper" "$@")
  if [ "$got" != "$want" ]; then
    printf 'FAIL: pi %s\n  want %s\n  got  %s\n' "$*" "$want" "$got" >&2
    fail=1
  fi
}

e="[-e][$ext]"

# Paperclip's pi_local run and its environment test.
check "$e[--mode][json][-p][--tools][read,bash,edit,write,grep,find,ls,web_search][do it]" \
  --mode json -p --tools read,bash,edit,write,grep,find,ls "do it"
check "$e[-p][Respond with hello.][--tools][read,web_search]" -p "Respond with hello." --tools read
# The short form, and a list that already has web_search.
check "$e[-t][read,web_search]" -t read
check "$e[--tools][web_search,read]" --tools web_search,read
# Each list gets web_search (pi keeps the last one).
check "$e[--tools][read,web_search][-t][bash,web_search]" --tools read -t bash
# An empty list stays empty.
check "$e[--tools][]" --tools ""
check "$e[--tools][ , ]" --tools " , "
# pi does not read --tools=x as a tool list, so neither does the wrapper.
check "$e[--tools=read]" --tools=read
# Arguments with spaces stay whole.
check "$e[--append-system-prompt][a b  c][--tools][read,web_search][one two]" \
  --append-system-prompt "a b  c" --tools read "one two"
# After --, nothing changes, and --no-* there does not count.
check "$e[--tools][read,web_search][--][--tools][x][--no-tools]" --tools read -- --tools x --no-tools
# A value that looks like --: the next argument after --tools is the list.
check "$e[--tools][--,web_search]" --tools --
# --no-tools and --no-extensions (long and short): unchanged.
check "[--no-tools][--tools][read]" --no-tools --tools read
check "[-nt][-t][read]" -nt -t read
check "[--tools][read][--no-extensions]" --tools read --no-extensions
check "[-ne][--tools][read]" -ne --tools read
# A subcommand: unchanged.
check "[install][npm:foo][--tools][read]" install npm:foo --tools read
check "[list]" list
# --version and --help: only -e is added, which pi ignores for them.
check "$e[--version]" --version
check "$e[--help]" --help
# No arguments: unchanged.
check ""

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "pi-slot.sh argument tests: ok"
