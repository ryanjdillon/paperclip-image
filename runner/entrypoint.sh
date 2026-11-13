#!/bin/sh
# Copy the mounted keys to paths sshd accepts (Secret mounts are symlinks
# with group-readable modes, and StrictModes wants a private home), prepare
# the workspace root, and run sshd in the foreground with its log on stderr.
set -eu

keys=${KEYS_DIR:-/keys}

# StrictModes refuses a home that another user owns or can write, and only
# the owner can tighten it: the volume must be owned by this UID (the
# Deployment's initContainer chowns it).
if [ "$(stat -c %u "$HOME")" != "$(id -u)" ]; then
  echo "entrypoint: $HOME must be owned by UID $(id -u) (it is $(stat -c %u:%g "$HOME"))" >&2
  exit 1
fi
mkdir -p /tmp/sshd
install -m 600 "$keys/ssh_host_ed25519_key" /tmp/sshd/ssh_host_ed25519_key
chmod 700 "$HOME"
mkdir -p "$HOME/.ssh" "$HOME/workspaces"
chmod 700 "$HOME/.ssh"
install -m 600 "$keys/authorized_keys" "$HOME/.ssh/authorized_keys"

# Paperclip's driver sources these before every command, and the home
# persists: remove whatever a previous run left, so a restart starts clean.
rm -f "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" \
  "$HOME/.zprofile" "$HOME/.ssh/rc" "$HOME/.ssh/environment"

/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
