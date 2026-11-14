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
  allow only managed hooks (none are defined), and turn off the self-updater
  and non-essential traffic. MCP servers are limited to Paperclip's own (its
  Service URL, or a loopback bridge): a repository's `.mcp.json` or
  `.claude/settings.json` cannot add or auto-approve others. That matters
  because Paperclip's `claude_local` agents run with
  `--setting-sources user,project`, so project settings apply. Agents cannot
  override managed settings.
- pi providers: a `models.json` mounted at
  `/etc/paperclip-runner/pi/models.json` is copied to `~/.pi/agent/` on start
  (after the reset), so pi knows custom providers, e.g. the AI gateway, even
  where Paperclip runs it without per-run config (its environment test).
- Agent CLIs: Claude Code and pi (`pi_local`, run offline: no version
  checks, telemetry or tool downloads).
- Base tools: git, curl, jq, python3 (with venv), make, unzip, less, file,
  xz, ripgrep and fd. Anything more comes from the repository's own flake.
- Nix (single-user, static binary at `/usr/local/bin/nix`, flakes on): mount
  a volume at `/nix` owned by UID 1000 (the same initContainer can chown it).
  Agents run a repository's toolchain with `nix develop -c <cmd>`, pinned by
  its `flake.lock`. `/etc/nix/nix.conf` allows cache.nixos.org only, with
  signatures required, and ignores a flake's `nixConfig`. There is no build
  sandbox (it needs user namespaces, which RuntimeDefault seccomp refuses).
  No flake registries, no user nix.conf (`NIX_USER_CONF_FILES` is empty),
  builds in `/nix/var/nix/builds` rather than `/tmp`, and garbage collection
  when the volume's filesystem has under 10 GiB free. At every start, before
  sshd, the store is checked (see Limits); over `NIX_STORE_GC_MB` (default
  40000) it is emptied instead. Without a writable `/nix`, nix is unavailable
  and everything else works.
- Install hygiene: npm (and pnpm) skip dependency install scripts
  (`ignore-scripts`, in the global npmrc and the profile); a run opts in per
  command with `--ignore-scripts=false`, visibly. Use lockfile installs
  (`npm ci`, `pnpm install --frozen-lockfile`, `cargo --locked`,
  `uv sync --locked`) and no `curl | sh`.
- The base image is pinned by digest and the CLIs by version. Renovate bumps
  the base and Claude Code; pi is bumped by hand with Paperclip's adapter.

### Limits

Runs on one runner share a UID and a persistent home. One run can read
another's environment through `/proc` while both are live, and **between
restarts anything one run leaves in the home applies to every later run**:
shell startup files, Claude Code settings and extensions, git config, files
and git hooks in reused workspaces, and other agents' session transcripts.

On start the entrypoint removes the shell startup files, Claude Code's user
settings, memory and extensions, its user-scope MCP servers, pi's user config
(`~/.pi`, `~/.agents`), git's user config and `~/.npmrc`, Nix's user
and nixpkgs config, registry, profiles and fetcher cache, Python's user
site-packages and pip/uv config, and rebuilds `~/.ssh`; sshd never runs
`~/.ssh/rc`. Python ignores user site-packages anyway (`PYTHONNOUSERSITE`).
Workspaces and session transcripts (`~/.claude/projects`, needed to resume)
are kept. The host private key is readable by runs too (same UID).

In single-user mode the agent user owns the Nix store: a run can make a store
path writable and change it, or edit the database. At every start
`nix-store-check` verifies the whole store with only the image's config: each
path must be signed by cache.nixos.org (or be content-addressed) and match its
recorded hash. Failing paths are deleted with everything that refers to them;
unsigned paths are local builds and are rebuilt when needed. GC roots,
profiles and entries the database does not know are removed. If the check
cannot run, the store is wiped. Between two starts runs share the store, so
they are one trust domain until fresh pods per run. Nix's own binary is in the
image and cannot be changed.

Config that arrives with a workspace (a repository's `.pi/`, `.claude/` or
`AGENTS.md`) is part of that repository's trust, not reset here.

Run one runner per trust level, and allow port 2222 only from the Paperclip
server.

When the server's SSH client dies mid-run, the agent gets no hang-up signal
(there is no TTY); it runs until its next write fails, and tini reaps it.

## Build

Only `main` publishes: pushes that touch an image directory, and
`workflow_dispatch` on `main`. Pull requests and other branches only build.
The run summary prints the digest. **Pin the digest**: the date and `latest`
tags move.
