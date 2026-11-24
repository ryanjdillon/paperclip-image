#!/bin/sh
# ssh ProxyCommand for git@github.com (ssh_config_github.conf, DIL-888).
# In a run, /etc/profile sets https_proxy to the cluster's egress proxy
# (agent-egress), so this opens the SSH connection as an HTTP CONNECT tunnel
# through it. Without a proxy, for example in a job that uses this image but
# reads no profile, it connects directly, as ssh would by itself.
# OpenBSD netcat speaks the CONNECT side; it sends HTTP/1.0, which the proxy
# accepts.
set -eu
host=$1
port=$2
proxy=${https_proxy:-${HTTPS_PROXY:-}}
if [ -z "$proxy" ]; then
  exec nc "$host" "$port"
fi
# http://user@host:port/ -> host:port
hostport=${proxy#*://}
hostport=${hostport%%/*}
hostport=${hostport##*@}
exec nc -X connect -x "$hostport" "$host" "$port"
