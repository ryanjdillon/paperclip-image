#!/bin/sh
# Prepare the home and run sshd in the foreground with its log on stderr.
#
# The home persists across restarts and every run writes to it as the same
# user, so anything that would execute or steer a later run is reset here:
# shell startup files (sourced by Paperclip's driver before every command,
# and by bash), Claude Code's user settings, memory and extensions, pi's user
# config, extensions and skills (~/.pi, ~/.agents), git's user config, and
# ~/.ssh. Neither CLI keeps sessions there over SSH: Paperclip passes them
# per run. Paths are removed with rm -rf, so a planted
# directory or symlink cannot stop the runner from starting.
set -eu

keys=${KEYS_DIR:-/keys}

# StrictModes refuses a home that another user owns or can write, and only
# the owner can tighten it: the volume must be owned by this UID (the
# Deployment's initContainer chowns it).
if [ "$(stat -c %u "$HOME")" != "$(id -u)" ]; then
  echo "entrypoint: $HOME must be owned by UID $(id -u) (it is $(stat -c %u:%g "$HOME"))" >&2
  exit 1
fi
chmod 700 "$HOME"

for path in \
  .profile \
  .bashrc \
  .bash_profile \
  .bash_login \
  .zprofile \
  .zshrc \
  .ssh \
  .gitconfig \
  .config/git \
  .npmrc \
  .node_modules \
  .node_libraries \
  .claude/settings.json \
  .claude/settings.local.json \
  .claude/CLAUDE.md \
  .claude/agents \
  .claude/commands \
  .claude/skills \
  .claude/plugins \
  .claude/output-styles \
  .claude/hooks \
  .pi \
  .agents
do
  rm -rf "${HOME:?}/$path"
done

# User-scope MCP servers in ~/.claude.json start with every session. Keep
# the file (it holds onboarding state; without it startup dialogs block a
# run) but drop the servers.
if [ -f "$HOME/.claude.json" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let c;
    try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch { fs.rmSync(p, { force: true }); process.exit(0); }
    delete c.mcpServers;
    for (const k of Object.keys(c.projects || {})) delete c.projects[k].mcpServers;
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  ' "$HOME/.claude.json"
fi

mkdir -m 700 "$HOME/.ssh"
install -m 600 "$keys/authorized_keys" "$HOME/.ssh/authorized_keys"
mkdir -p /tmp/sshd
install -m 600 "$keys/ssh_host_ed25519_key" /tmp/sshd/ssh_host_ed25519_key
if [ ! -d "$HOME/workspaces" ]; then
  rm -rf "$HOME/workspaces"
  mkdir "$HOME/workspaces"
fi

/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
