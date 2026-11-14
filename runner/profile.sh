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
