#!/bin/sh
# Google Antigravity's ACP server, for gemini_local agents with agentCommand
# `agy-acp` (DIL-963). The server signs in to Google through the agy-broker
# (runner/agy-broker), which keeps the real token in its own pod (DIL-973).
# The runner reaches it through its Service. A NetworkPolicy admits only the
# runner pods from the cluster (and kube-router admits the broker node's own
# processes). An agent cannot take over the address, as it could on the
# shared loopback of a sidecar.
# This wrapper gives the server only dummy credentials, sends its traffic
# through the broker, and makes it trust the broker's CA.
#
# Paperclip runs come in over SSH, so they do not see the container's
# environment: the defaults below are the deployment's fixed paths.
# GEMINI_HOME is fixed too, because Paperclip points HOME at a new directory
# for each remote run. Every agent on the runner shares one user, so every
# agent can read and change this directory, transcripts included, also while
# a server runs. It holds no secret.
# Installed as /usr/local/bin/agy-acp by the Dockerfile, which fills in the
# real server.
set -eu

real=@AGY_REAL@
broker=${AGY_BROKER_URL:-http://agy-broker.paperclip-agents.svc.cluster.local:8787}
ca=${AGY_BROKER_CA:-/etc/paperclip-runner/agy/ca.crt}
GEMINI_HOME=${GEMINI_HOME:-/home/node/.antigravity}

if [ ! -r "$ca" ]; then
  echo "agy-acp: the broker CA $ca is missing" >&2
  exit 69
fi

umask 077
state="$GEMINI_HOME/antigravity-acp"
mkdir -p "$state"
token_tmp="$state/.acp_token.json.$$"
settings_tmp="$state/.settings.json.$$"
bundle="$GEMINI_HOME/ca-bundle.crt"
bundle_tmp="$bundle.$$"
# A signal must run the EXIT trap, which removes the temporary files. sh
# runs the EXIT trap on `exit`, but not when a signal kills it.
trap 'exit 130' INT TERM HUP
trap 'rm -f "$token_tmp" "$settings_tmp" "$bundle_tmp"' EXIT

# Rewritten before every start, so that the server starts from known files:
# a missing or changed token file or setting makes the server wait for a
# browser sign-in until the run times out. The files hold no secret: the
# broker serves dummy tokens and public client IDs. --noproxy: this request
# goes to the broker itself, never through a proxy that the caller has set.
if ! curl -fsS --noproxy '*' --max-time 10 "$broker/dummy-credentials" >"$token_tmp"; then
  echo "agy-acp: the broker at $broker does not answer" >&2
  exit 69
fi
mv -f "$token_tmp" "$state/acp_token.json"
printf '{"auth":{"type":"oauth-personal"}}\n' >"$settings_tmp"
mv -f "$settings_tmp" "$state/settings.json"
cat /etc/ssl/certs/ca-certificates.crt "$ca" >"$bundle_tmp"
mv -f "$bundle_tmp" "$bundle"
trap - EXIT

AGY_ACP_FORCE_FILE_STORAGE=1
# The broker is the proxy for the server and for every process it starts,
# the commands that it runs for an agent included. Those bypass the runner's
# egress proxy (agent-egress, DIL-888) and its allowlist. The server reads
# its proxy only from the environment, so the fix is in the broker or in
# its egress (DIL-993).
HTTPS_PROXY=$broker
https_proxy=$broker
# The broker host is not in NO_PROXY: a client never sends its connection to
# the proxy through the proxy, so the entry would change nothing.
NO_PROXY=127.0.0.1,localhost
no_proxy=$NO_PROXY
HTTPLIB2_CA_CERTS=$bundle
SSL_CERT_FILE=$bundle
REQUESTS_CA_BUNDLE=$bundle
export GEMINI_HOME AGY_ACP_FORCE_FILE_STORAGE HTTPS_PROXY https_proxy NO_PROXY \
  no_proxy HTTPLIB2_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE
# --uid= is the argument list that Paperclip pins for the linux builds
# (antigravity-distributions.json). Google does not document it; keep it
# with the pin.
exec "$real" --uid= "$@"
