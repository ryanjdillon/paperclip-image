# paperclip-image

Container images for the [Paperclip](https://paperclip.ing) deployment in
[nix-config](https://github.com/ryanjdillon/nix-config) (`k3s/apps/paperclip`).
The plugin code lives in
[paperclip-linear](https://github.com/ryanjdillon/paperclip-linear); this
repository only builds images.

| Directory | Image | Purpose |
|---|---|---|
| `runner/` | `ghcr.io/ryanjdillon/paperclip-agent-runner` | Target of a Paperclip `ssh` execution environment: agents run here, apart from the server and its secrets |
| `sandbox-ssh/` | `ghcr.io/ryanjdillon/paperclip-sandbox-ssh` | Sandbox provider plugin that runs a Paperclip sandbox environment on the runner over SSH (see its README) |

The server image (Paperclip plus the paperclip-linear plugin) will move here
from paperclip-linear.

## Runner

Paperclip's SSH environment runs each agent command over SSH on the runner.
Only the run's own environment crosses: the server's database URL, auth secret
and secrets key stay on the server. The agent's calls back to Paperclip go to
a small node bridge on the runner's loopback; the server polls its file queue
with short SSH commands about every 100 ms. So a Legacy run needs no network
path to the server.

Paperclip's own runner (`runner: paperclip`, ACP) works differently. The
runner daemon dials back to the server over `wss://` for each run, and it
loads the agents from a provider pack. The server cannot copy that pack over
ssh, so the image carries it:

- `/opt/paperclip-runner/provider-pack` (about 2.7 GB) and
  `/opt/paperclip-runner/bin/paperclip-runnerd` come from the Paperclip image
  that the server runs (the `paperclip` stage in `runner/Dockerfile`). Bump
  that digest together with the base image of the server (paperclip-linear).
- Both are root-owned and not writable by the agent user. Only then does the
  daemon report the pack as protected, and Paperclip 2026.1117.0 and later
  accept a protected pack across compatible server releases. The build fails
  when the daemon does not report the pack as protected, when the pack does
  not target linux/x64, or when the daemon lacks `dial_wss`.

The runner itself:

- `sshd` runs unprivileged as `node` (UID and GID 20100) on port 2222: public keys
  only, no TTY, no forwarding, no sftp.
- Keys are mounted from a Secret at `/keys` (`ssh_host_ed25519_key`,
  `authorized_keys`) with a mode UID 20100 can read (`0444`, or `0440` with
  `fsGroup: 20100`). The entrypoint copies the host key to `/tmp/sshd` and
  `authorized_keys` to `~/.ssh`.
- Mount a volume at `/home/node` (workspaces and Claude Code's session state).
  It must be owned by UID 20100 and not group- or world-writable, or sshd's
  StrictModes refuses every login; the entrypoint exits with a clear message
  if the owner is wrong. An initContainer running as root can
  `chown 20100:20100 /home/node && chmod 700 /home/node`.
- Pin the host key on the Paperclip side: put `[host]:2222 ssh-ed25519 …` in
  the environment's known hosts and turn on strict host key checking.
  Otherwise the driver accepts any host key.
- Claude Code's managed settings (`/etc/claude-code/managed-settings.json`)
  allow only managed hooks (none are defined), and turn off the self-updater
  and non-essential traffic. `allowManagedMcpServersOnly` with an allowlist of
  loopback bridges (`127.0.0.1`) is what keeps every other MCP server out.
  The ACPX runner tool bridge listens at `http://127.0.0.1:<port>/mcp`, with
  no path after `/mcp`. A pattern that ends in `/mcp/*` does not match it, so
  the list also has the exact `/mcp` path. Without it, Claude drops the bridge
  and has no `paperclip_finish` tool (Paperclip 2026.1117.0,
  `startRunnerToolBridge` in
  `packages/paperclip-runner/src/drivers/runner-tool-bridge.ts`).
  Paperclip's own servers on its Service URL are also on the deny list, because
  the runner's network policy blocks the server and Claude would otherwise fail
  to reach them on every run (Paperclip attaches them to every run, with no
  setting to turn them off). A repository's `.mcp.json` or
  `.claude/settings.json` cannot add or auto-approve others. That matters
  because Paperclip's `claude_local` agents run with
  `--setting-sources user,project`, so project settings apply. Agents cannot
  override managed settings.
- pi providers: `~/.pi/agent/models.json` is a symlink, made on start (after
  the reset), to the `models.json` mounted at
  `/etc/paperclip-runner/pi/models.json`, so pi knows custom providers, e.g.
  the AI gateway, even where Paperclip runs it without per-run config (its
  environment test). Mount it as a ConfigMap directory (no `subPath`): the
  kubelet updates the file in place, and the next pi process reads the new
  list, so model changes need no runner restart.
- Agent CLIs: Claude Code and pi (`pi_local`, run offline: no version
  checks, telemetry or tool downloads).
- Google Antigravity's ACP server (`agy-acp`, `runner/agy-acp.sh`), for a
  `gemini_local` agent with `agentCommand: agy-acp`. It uses a Google sign-in
  (a Gemini subscription), so it needs no API key.
  - The real Google token stays in the `agy-broker` sidecar
    (`runner/agy-broker`). Every agent on the runner shares one user, so a
    token in the agent container would be readable by all of them.
  - Run the sidecar from this image with
    `node /usr/local/lib/agy-broker/agy-broker.mjs`. It listens on
    `127.0.0.1:8787`. It reads `token.json`, `tls.key` and `tls.crt` from
    `/run/secrets/agy-broker/`.
  - `agy-acp` needs the broker's CA at `/etc/paperclip-runner/agy/ca.crt`.
    Before every start, it writes the broker's dummy credentials and
    `{"auth": {"type": "oauth-personal"}}` to `$GEMINI_HOME/antigravity-acp/`.
    Then it sends the server's traffic through the broker.
  - The broker terminates TLS for `oauth2.googleapis.com` and the two
    `cloudcode-pa` hosts only. It swaps the dummy token for the real one on
    `v1internal` calls and refuses all other requests to those hosts. It does
    not follow redirects. It tunnels other hosts unchanged.
  - An agent can still send prompts through the broker. It cannot read the
    real token or reach other Google APIs.
  - `GEMINI_HOME` defaults to `/home/node/.antigravity`. It must not be under
    `HOME`, because Paperclip points `HOME` at a new directory for each remote
    run. The server keeps transcripts and conversation databases there, so
    that directory grows. Every agent can read and change it, transcripts
    included.
  - The server ignores the agent's model (Paperclip sends it as
    `GEMINI_MODEL`). Set `AGY_ACP_DEFAULT_MODEL` in the agent's env instead,
    for example `gemini-4-neon-high`.
  - If the broker cannot refresh the real token, model calls fail with HTTP
    502. A missing `settings.json` or token file would make the server wait
    for a browser sign-in until the run times out. `agy-acp` writes both
    before every start to prevent that.
- pi runs through a slot cap (`/usr/local/bin/pi`, `runner/pi-slot.sh`): at
  most N pi processes at once on the runner, N from `max-concurrent` in the
  pi mount (`/etc/paperclip-runner/pi/`), 1 to 16, default 2. The pi agents
  share one gateway key, and its upstream allows only a few parallel
  requests. A run that finds every slot busy waits, up to an hour, and the
  wait counts against Paperclip's run and environment-test timeouts (the
  test's hello probe allows 60 s). A waiter whose SSH session is gone exits
  without starting pi. pi started from inside a pi run skips the cap. It is
  cooperative: an agent on the runner can get around it, and the upstream's
  own limit is the hard one.
- `env` and `printenv` (`/usr/local/lib/paperclip-shims`, linked from
  `/usr/local/bin`) print variable names only when listing; `env NAME=VALUE
  cmd`, `--help` and `--version` pass through unchanged, and `printenv NAME`
  answers "set" or "unset" (an empty value counts as set). `nix develop` puts
  its own coreutils first on PATH, so a repository's dev shell has to
  re-prepend `$PAPERCLIP_SHIM_DIR` (exported by `/etc/profile.d`; skrap's flake
  does). A run's environment holds its Paperclip API key
  and the agent's private key, and printing them ends the run at the gateway's
  scan gate. `/usr/bin/env`, `set`, `export -p`, `declare -p` and
  `/proc/self/environ` still show values: this stops the common accident, not
  a determined agent.
- git to GitHub over SSH on port 443 (`ssh.github.com`, since egress is
  HTTPS only): `/etc/ssh/ssh_config.d/github.conf` uses a deploy key mounted
  at `/run/secrets/git/skrap/key` and GitHub's host keys pinned in
  `/etc/ssh/github_known_hosts`. Commits are made as "dillonteknisk agents"
  (`/etc/gitconfig`).
- Base tools: git, curl, jq, python3 (with venv), make, unzip, less, file,
  xz, ripgrep and fd. Anything more comes from the repository's own flake.
- Nix (single-user, static binary at `/usr/local/bin/nix`, flakes on): mount
  a volume at `/nix` owned by UID 20100 (the same initContainer can chown it).
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
path writable and change it, or edit the database. At every start, before
sshd, `nix-store-check` checks the whole store with only the image's config.
A path is kept only if its contents match its recorded hash and it is signed
by cache.nixos.org, or it is a sha256 fixed-output path (a source) whose
contents hash to its name. Nix itself trusts every content-addressed path
without checking its contents against its name, so text paths (`.drv` files)
are always deleted; evaluation writes them again. The database must have
exactly the schema of a fresh Nix database (recorded at image build, where a
self-test also pins the hash formats), so a planted trigger cannot
re-register a deleted path, and the store must end up as exactly the paths
that passed. Failing paths are deleted
with everything that refers to them; unsigned paths are local builds and are
rebuilt when needed. Everything on the volume but the store and its database
(GC roots, profiles, build logs) is removed, as are store entries the
database does not know. Any problem with the check (an unreadable database,
a symlink in place of a store directory, an error) wipes the store; only a
failed wipe stops the runner. Between
two starts runs share the store, so they are one trust domain until fresh
pods per run. Nix's own binary is in the image and cannot be changed.

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
