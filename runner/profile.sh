# Sourced by /etc/profile, which Paperclip's SSH driver loads before every
# command. sshd starts sessions with a clean environment, so container ENV
# values never reach the agent; anything an agent CLI needs goes here.
export DISABLE_AUTOUPDATER=1
# pi: no version checks, telemetry or tool downloads.
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
# npm: no dependency install scripts (also in the global npmrc; the variable
# beats a ~/.npmrc that an earlier run in this pod may have written).
export npm_config_ignore_scripts=true
# Nix (/usr/local/bin/nix): Debian's CA bundle for its fetchers, also set in
# /etc/nix/nix.conf. Toolchains come from `nix develop -c <cmd>` in a repo
# with a flake; there is deliberately no profile on PATH.
export NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
# Nix reads no user config file (~/.config/nix/nix.conf), only the image's
# /etc/nix/nix.conf: set but empty means an empty list of user files.
export NIX_USER_CONF_FILES=
# Python: no user site-packages, so a .pth file a run leaves in
# ~/.local/lib/python3.*/site-packages cannot run code in later runs.
export PYTHONNOUSERSITE=1
# env/printenv that list names only (env-names.sh); a dev shell that puts its
# own coreutils first on PATH re-prepends this directory (skrap's flake does).
export PAPERCLIP_SHIM_DIR=/usr/local/lib/paperclip-shims
# Egress (DIL-888): HTTPS goes through the cluster's CONNECT proxy, which logs
# each host and holds the allowlist. The runner's NetworkPolicy is the
# boundary, not these variables. NO_PROXY keeps cluster names direct: the
# runner ingress and the agy-broker (.svc.cluster.local, and the short .svc
# form). The AI gateway is plain http://, which HTTPS_PROXY never covers.
# git over SSH uses the proxy through ssh-proxy-connect. agy-acp sets its own
# HTTPS_PROXY, the broker, for agy and its child processes (DIL-993).
# NODE_USE_ENV_PROXY: Node 24.0.0 and later (Node.js CLI docs) then route
# requests through HTTPS_PROXY and honour NO_PROXY; checked on Node 24.22.3
# for fetch and https.get. Without it Node ignores the variables, and a Node
# tool's request is refused once the runner has no direct HTTPS rule.
export https_proxy=http://agent-egress.paperclip-agents.svc.cluster.local:3128
export HTTPS_PROXY=$https_proxy
export no_proxy=localhost,127.0.0.1,::1,.svc,.cluster.local
export NO_PROXY=$no_proxy
export NODE_USE_ENV_PROXY=1
