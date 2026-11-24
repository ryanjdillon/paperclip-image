#!/bin/sh
# pi through a slot: at most N pi processes run at once on this runner. Its
# pi agents share one gateway key whose upstream allows a few parallel
# requests (airouter: 3, shared with other clients), so a busy board must not
# take them all. N comes from the deployment's pi mount (`max-concurrent`,
# 1 to 16), default 2. A run that finds every slot busy waits for one.
#
# This shell holds the slot's lock and runs pi with the lock's descriptor
# closed, so a background process that a run leaves behind does not keep the
# slot. The lock files are opened for append, so a symlink planted in their
# place cannot truncate anything. It is a cooperative limit (an agent on the
# runner can get around it); the upstream's own limit is the hard one.
# Installed as /usr/local/bin/pi by the Dockerfile, which fills in the real pi.
set -eu

real=@PI_REAL@

# The image's own pi extensions (web_search, DIL-994). Paperclip's pi_local
# adapter starts pi with `--tools read,bash,edit,write,grep,find,ls`, an
# allowlist that also applies to extension tools, and it can point
# PI_CODING_AGENT_DIR at its own directory, so neither auto-discovery nor a
# tool that is not on the list reaches a run. So, for an agent run (the
# first argument is an option, not a subcommand such as `install`), add
# `-e <extension>` and add web_search to a `--tools`/`-t` list. With
# `--no-extensions` or `--no-tools` the arguments stay as they are.
ext=/opt/pi-extensions/web-search.ts
case "${1:-}" in
  -*)
    add=1
    for a do
      case "$a" in
        --no-extensions | -ne | --no-tools | -nt) add=0 ;;
      esac
    done
    if [ "$add" = 1 ] && [ -r "$ext" ]; then
      tools_next=0
      first=1
      for a do
        if [ "$first" = 1 ]; then
          set -- -e "$ext"
          first=0
        fi
        if [ "$tools_next" = 1 ]; then
          case ",$a," in
            *,web_search,*) ;;
            *) a="$a,web_search" ;;
          esac
          tools_next=0
        fi
        case "$a" in
          --tools | -t) tools_next=1 ;;
        esac
        set -- "$@" "$a"
      done
    fi
    ;;
esac

# pi started by a pi run (its bash tool sets PI_CODING_AGENT) belongs to that
# run's slot; waiting for another would deadlock when every slot is a parent.
if [ "${PI_CODING_AGENT:-}" = true ]; then
  exec "$real" "$@"
fi

conf=${PI_SLOTS_FILE:-/etc/paperclip-runner/pi/max-concurrent}
slots=2
if [ -r "$conf" ]; then
  n=$(tr -dc 0-9 <"$conf" | cut -c1-3)
  if [ -n "$n" ] && [ "$n" -ge 1 ] && [ "$n" -le 16 ]; then
    slots=$n
  else
    echo "pi: ignoring max-concurrent in $conf (want 1 to 16); using $slots" >&2
  fi
fi

# The longest a run waits for a slot before giving up (seconds).
max_wait=${PI_SLOT_WAIT_MAX:-3600}
dir=/tmp/pi-slots
mkdir -p "$dir"
waited=0
while :; do
  i=1
  while [ "$i" -le "$slots" ]; do
    exec 9>>"$dir/$i"
    if flock -n 9; then
      rc=0
      "$real" "$@" 9>&- || rc=$?
      exit "$rc"
    fi
    exec 9>&-
    i=$((i + 1))
  done
  # A cancelled run's session is gone, but nothing signals this shell (no
  # TTY, so no SIGHUP): stop once the parent (the SSH session) has exited,
  # and say so on stderr every half minute, which also ends this shell
  # (SIGPIPE) once the session's stderr is closed.
  if ! kill -0 "$PPID" 2>/dev/null; then
    exit 129
  fi
  if [ $((waited % 30)) -eq 0 ]; then
    echo "pi: all $slots pi slots on this runner are busy; waiting (${waited}s)" >&2
  fi
  if [ "$waited" -ge "$max_wait" ]; then
    echo "pi: no pi slot free after ${waited}s; giving up" >&2
    exit 75
  fi
  sleep 2
  waited=$((waited + 2))
done
