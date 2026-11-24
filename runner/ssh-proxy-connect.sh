#!/bin/sh
# ssh ProxyCommand for git@github.com (ssh_config_github.conf, DIL-888).
# In a run, /etc/profile sets https_proxy to the cluster's egress proxy
# (agent-egress), so this opens the SSH connection as an HTTP CONNECT tunnel
# through it. Without a proxy, for example in a job that uses this image but
# reads no profile, it connects directly, as ssh would by itself.
# OpenBSD netcat speaks the CONNECT side. It sends HTTP/1.0, which the proxy
# accepts because nix-config's agent-egress/envoy.yaml sets accept_http_10.
# The proxy takes no credentials, so a proxy URL with a user or password is
# refused rather than sent.
# SSH_PROXY_CONNECT_NC replaces netcat, for the image's build test only.
set -eu
nc=${SSH_PROXY_CONNECT_NC:-/usr/bin/nc.openbsd}
host=$1
port=$2
proxy=${https_proxy:-${HTTPS_PROXY:-}}
if [ -z "$proxy" ]; then
  exec "$nc" -w 15 "$host" "$port"
fi
# http://host:port/ -> host:port
hostport=${proxy#*://}
hostport=${hostport%%/*}
case $hostport in
  *@*)
    echo "ssh-proxy-connect: the proxy URL has credentials; refusing to send them" >&2
    exit 64
    ;;
  "")
    echo "ssh-proxy-connect: no host in the proxy URL" >&2
    exit 64
    ;;
esac
exec "$nc" -w 15 -X connect -x "$hostport" "$host" "$port"
