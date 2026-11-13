#!/bin/sh
# Copy the mounted keys to paths sshd accepts (Secret mounts are symlinks
# with group-readable modes, and StrictModes wants a private home), prepare
# the workspace root, and run sshd in the foreground with its log on stderr.
set -eu

keys=${KEYS_DIR:-/keys}
mkdir -p /tmp/sshd
install -m 600 "$keys/ssh_host_ed25519_key" /tmp/sshd/ssh_host_ed25519_key
chmod 700 "$HOME"
mkdir -p "$HOME/.ssh" "$HOME/workspaces"
chmod 700 "$HOME/.ssh"
install -m 600 "$keys/authorized_keys" "$HOME/.ssh/authorized_keys"

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
