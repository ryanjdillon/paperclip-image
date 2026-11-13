# paperclip-image

Container images for the [Paperclip](https://paperclip.ing) deployment in
[nix-config](https://github.com/ryanjdillon/nix-config) (`k3s/apps/paperclip`).
The plugin code lives in
[paperclip-linear](https://github.com/ryanjdillon/paperclip-linear); this
repository only builds images.

| Directory | Image | Purpose |
|---|---|---|
| `runner/` | `ghcr.io/ryanjdillon/paperclip-agent-runner` | Target of a Paperclip `ssh` execution environment: agents run here, apart from the server and its secrets |

The server image (Paperclip plus the paperclip-linear plugin) will move here
from paperclip-linear.

## Runner

Paperclip's SSH environment opens one session per run and executes the agent
CLI on the runner. Only the run's own environment crosses: the server's
database URL, auth secret and secrets key stay on the server. The agent's
calls back to Paperclip go through a per-run bridge over the same SSH
connection, so the runner needs no network path to the server.

- `sshd` runs unprivileged as `node` (UID 1000) on port 2222, keys only, with
  forwarding and TTYs disabled.
- The host key and `authorized_keys` are mounted at `/keys`
  (`ssh_host_ed25519_key`, `authorized_keys`); the entrypoint copies them into
  `/tmp/sshd`.
- Workspaces live under `/home/node/workspaces`. Mount a volume at
  `/home/node` so the Claude Code session state persists.
- Pinned: the Node base image by digest, Claude Code by version
  (`CLAUDE_CODE_VERSION`).

## Build

Pull requests build without pushing. Pushes to `main` that touch an image
directory build and publish it, and `workflow_dispatch` rebuilds on demand.
The run summary prints the digest. **Pin the digest**: the date and `latest`
tags move.
