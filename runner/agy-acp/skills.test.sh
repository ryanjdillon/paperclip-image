#!/bin/sh
# Build-time tests for the skills link in agy-acp.sh (DIL-963). The
# Dockerfile runs this on a copy of the installed wrapper whose real server
# is a stub. The stub prints where $GEMINI_HOME/config/skills points, or
# "none". A file:// broker URL stands in for the broker:
#   skills.test.sh <wrapper> <stub>
set -eu

wrapper=$1
stub=$2
fail=0
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT

mkdir -p "$t/broker" "$t/gh"
printf '{}\n' >"$t/broker/dummy-credentials"
printf 'test CA\n' >"$t/ca.crt"
sed "s|^real=.*|real=$stub|" "$wrapper" >"$t/agy-acp"
chmod 755 "$t/agy-acp"
grep -qx "real=$stub" "$t/agy-acp"

# run <HOME or -> : starts the wrapper, with HOME unset for "-".
run() {
  if [ "$1" = - ]; then
    env -u HOME GEMINI_HOME="$t/gh" AGY_BROKER_URL="file://$t/broker" \
      AGY_BROKER_CA="$t/ca.crt" "$t/agy-acp" </dev/null
  else
    env HOME="$1" GEMINI_HOME="$t/gh" AGY_BROKER_URL="file://$t/broker" \
      AGY_BROKER_CA="$t/ca.crt" "$t/agy-acp" </dev/null
  fi
}

check() {
  name=$1
  want=$2
  got=$3
  if [ "$got" != "$want" ]; then
    printf 'FAIL: %s\n  want %s\n  got  %s\n' "$name" "$want" "$got" >&2
    fail=1
  fi
}

mkdir -p "$t/run1/.gemini/skills/paperclip" "$t/run2/.gemini/skills/other" "$t/run3"
printf 'one\n' >"$t/run1/.gemini/skills/paperclip/SKILL.md"
printf 'two\n' >"$t/run2/.gemini/skills/other/SKILL.md"

# A run with skills gets the link, and the skill reads through it.
check "first run" "$t/run1/.gemini/skills" "$(run "$t/run1")"
check "skill file" one "$(cat "$t/gh/config/skills/paperclip/SKILL.md")"
# Each start replaces the link; a second start of the same run is the same.
check "same run again" "$t/run1/.gemini/skills" "$(run "$t/run1")"
check "next run" "$t/run2/.gemini/skills" "$(run "$t/run2")"
# A run without skills, or without HOME, does not see an older run's skills.
check "run without skills" none "$(run "$t/run3")"
run "$t/run1" >/dev/null
check "no HOME" none "$(run -)"
run "$t/run1" >/dev/null
check "relative HOME" none "$(cd "$t" && run run1)"
# The source went away after the link was made: the link goes.
run "$t/run2" >/dev/null
rm -rf "$t/run2/.gemini"
check "source removed" none "$(run "$t/run2")"
# No temporary link is left behind.
left=$(find "$t/gh/config" -mindepth 1 -maxdepth 1 ! -name skills)
check "no temporary files" "" "$left"
# A real directory is left alone, and the server still starts.
mkdir "$t/gh/config/skills"
check "real directory" "dir" "$(run "$t/run1" 2>/dev/null)"
if [ -L "$t/gh/config/skills" ] || [ ! -d "$t/gh/config/skills" ]; then
  echo "FAIL: real directory was changed" >&2
  fail=1
fi

[ "$fail" = 0 ] && echo "skills.test.sh: all passed"
exit "$fail"
