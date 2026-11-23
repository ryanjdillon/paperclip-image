#!/bin/sh
# Google Antigravity's ACP server, for gemini_local agents with agentCommand
# `agy-acp` (DIL-963). The server signs in to Google through the agy-broker
# sidecar (runner/agy-broker), which keeps the real token in its own container.
# This wrapper gives the server only dummy credentials, sends its traffic
# through the broker, and makes it trust the broker's CA.
#
# Paperclip runs come in over SSH, so they do not see the container's
# environment: the defaults below are the deployment's fixed paths.
# GEMINI_HOME is fixed too, because Paperclip points HOME at a new directory
# for each remote run. The server keeps transcripts there, so it grows.
# Installed as /usr/local/bin/agy-acp by the Dockerfile, which fills in the
# real server.
set -eu

real=@AGY_REAL@
broker=${AGY_BROKER_URL:-http://127.0.0.1:8787}
ca=${AGY_BROKER_CA:-/etc/paperclip-runner/agy/ca.crt}
GEMINI_HOME=${GEMINI_HOME:-/home/node/.antigravity}

if [ ! -r "$ca" ]; then
  echo "agy-acp: the broker CA $ca is missing" >&2
  exit 69
fi

umask 077
state="$GEMINI_HOME/antigravity-acp"
mkdir -p "$state"

# Rewritten on every start, so a changed file cannot steer a later run. The
# files hold no secret: the broker serves dummy tokens and public client IDs.
tmp="$state/.acp_token.json.$$"
if ! curl -fsS --max-time 10 "$broker/dummy-credentials" >"$tmp"; then
  rm -f "$tmp"
  echo "agy-acp: the broker at $broker does not answer" >&2
  exit 69
fi
mv -f "$tmp" "$state/acp_token.json"
printf '{"auth":{"type":"oauth-personal"}}\n' >"$state/.settings.json.$$"
mv -f "$state/.settings.json.$$" "$state/settings.json"

bundle="$GEMINI_HOME/ca-bundle.crt"
cat /etc/ssl/certs/ca-certificates.crt "$ca" >"$bundle.$$"
mv -f "$bundle.$$" "$bundle"

AGY_ACP_FORCE_FILE_STORAGE=1
HTTPS_PROXY=$broker
https_proxy=$broker
NO_PROXY=127.0.0.1,localhost
no_proxy=$NO_PROXY
HTTPLIB2_CA_CERTS=$bundle
SSL_CERT_FILE=$bundle
REQUESTS_CA_BUNDLE=$bundle
export GEMINI_HOME AGY_ACP_FORCE_FILE_STORAGE HTTPS_PROXY https_proxy NO_PROXY \
  no_proxy HTTPLIB2_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE
exec "$real" --uid= "$@"
