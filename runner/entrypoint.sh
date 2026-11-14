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
# directory or symlink cannot stop the runner from starting. pi's providers
# (~/.pi/agent/models.json) are then re-seeded from the deployment's mount.
#
# Nix: the store (/nix, its own volume) persists; it is content-addressed and
# every run's toolchains come from it. The user's Nix config, registry,
# profiles and fetcher cache are reset: a planted nix.conf or registry entry
# could point later runs at another cache or flake, and nothing needs a
# profile (`nix develop` does not use one, and none is on PATH).
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
  .agents \
  .config/nix \
  .nix-profile \
  .nix-defexpr \
  .nix-channels \
  .local/state/nix \
  .cache/nix
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

# pi's providers (models.json), when the deployment mounts them: the custom
# gateway provider must be in pi's own config dir, because Paperclip's
# environment test (and the agent verification built on it) runs pi without
# the per-run config that PAPERCLIP_PI_PROVIDERS produces.
# PI_MODELS_FILE overrides the path (local tests).
pi_models=${PI_MODELS_FILE:-/etc/paperclip-runner/pi/models.json}
if [ -r "$pi_models" ]; then
  mkdir -p -m 700 "$HOME/.pi" "$HOME/.pi/agent"
  install -m 600 "$pi_models" "$HOME/.pi/agent/models.json"
else
  echo "entrypoint: no pi models at $pi_models; pi knows only its built-in providers" >&2
fi

# The Nix store: usable only when /nix is a volume this user owns (the
# Deployment's initContainer chowns it). When it has grown past
# NIX_STORE_GC_MB, collect garbage in the background so sshd starts at once;
# no run holds a GC root, so this keeps only what a running build is using.
if [ -d /nix ] && [ -w /nix ]; then
  (
    used=$(du -sm /nix/store 2>/dev/null | cut -f1)
    if [ "${used:-0}" -gt "${NIX_STORE_GC_MB:-40000}" ]; then
      echo "entrypoint: nix store is ${used} MiB; collecting garbage" >&2
      nice nix store gc >/dev/null 2>&1 || echo "entrypoint: nix store gc failed" >&2
    fi
  ) &
else
  echo "entrypoint: /nix is not a writable volume; nix is unavailable" >&2
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
