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

Paperclip's SSH environment runs each agent command over SSH on the runner.
Only the run's own environment crosses: the server's database URL, auth secret
and secrets key stay on the server. The agent's calls back to Paperclip go to
a small node bridge on the runner's loopback; the server polls its file queue
with short SSH commands about every 100 ms. So the runner needs no network
path to the server.

- `sshd` runs unprivileged as `node` (UID 1000) on port 2222: public keys
  only, no TTY, no forwarding, no sftp.
- Keys are mounted from a Secret at `/keys` (`ssh_host_ed25519_key`,
  `authorized_keys`) with a mode UID 1000 can read (`0444`, or `0440` with
  `fsGroup: 1000`). The entrypoint copies the host key to `/tmp/sshd` and
  `authorized_keys` to `~/.ssh`.
- Mount a volume at `/home/node` (workspaces and Claude Code's session state).
  It must be owned by UID 1000 and not group- or world-writable, or sshd's
  StrictModes refuses every login; the entrypoint exits with a clear message
  if the owner is wrong. An initContainer running as root can
  `chown 1000:1000 /home/node && chmod 700 /home/node`.
- Pin the host key on the Paperclip side: put `[host]:2222 ssh-ed25519 …` in
  the environment's known hosts and turn on strict host key checking.
  Otherwise the driver accepts any host key.
- Claude Code's managed settings (`/etc/claude-code/managed-settings.json`)
  turn off its self-updater and non-essential traffic. Agents cannot override
  them.
- The base image is pinned by digest and Claude Code by version; Renovate
  bumps both.

### Limits

Runs on one runner share a UID and a persistent home. One run can read
another's environment through `/proc` while both are live, and can leave
files (`~/.profile`, `~/.claude/settings.json`, even `~/.ssh/authorized_keys`
until the next restart) that later runs pick up. Run one runner per trust
level, and allow port 2222 only from the Paperclip server.

When the server's SSH client dies mid-run, the agent gets no hang-up signal
(there is no TTY); it runs until its next write fails, and tini reaps it.

## Build

Only `main` publishes: pushes that touch an image directory, and
`workflow_dispatch` on `main`. Pull requests and other branches only build.
The run summary prints the digest. **Pin the digest**: the date and `latest`
tags move.
