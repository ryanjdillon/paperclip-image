#!/bin/sh
# gh in front of the real gh (DIL-1047), installed as /usr/local/bin/gh.
# With a token in the environment (a managed run: Paperclip's launcher has
# set GH_TOKEN from gh-broker), it runs the real gh unchanged. Without one
# (a host-mode Legacy run), it asks gh-broker for a token first. The token
# goes to gh in GH_TOKEN, never in argv. If the broker has no token, gh runs
# without one, and gh-broker-client says why on stderr.
real=@GH_REAL@
client=@GH_BROKER_CLIENT@
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  if token=$("$client" token); then
    GH_TOKEN=$token
    export GH_TOKEN
  fi
  unset token
fi
exec "$real" "$@"
