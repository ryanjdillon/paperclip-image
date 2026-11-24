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
  - The real Google token stays in the `agy-broker` pod
    (`runner/agy-broker`). Every agent on the runner shares one user, so a
    token in the agent container would be readable by all of them.
  - Run the broker from this image, in its own pod, with
    `node /usr/local/lib/agy-broker/agy-broker.mjs`. It listens on
    `0.0.0.0:8787` (`AGY_BROKER_HOST`, `AGY_BROKER_PORT`). It reads
    `token.json`, `tls.key` and `tls.crt` from `/run/secrets/agy-broker/`.
  - The broker does not authenticate its callers. Give it a Service named
    `agy-broker` in `paperclip-agents`, and a NetworkPolicy that admits only
    the runner pods. kube-router still admits processes on the broker's own
    node, so caller authentication is a follow-up. `agy-acp` uses
    `http://agy-broker.paperclip-agents.svc.cluster.local:8787`. A run comes
    in over SSH and does not see the container environment, so this default
    is in the wrapper.
  - `AGY_BROKER_LOG_HEADER_NAMES` (default `1`) logs the request header
    names of each new set on a `v1internal` forward, never the values.
    `AGY_BROKER_FORWARD_HEADERS` (a comma list) then forwards only those
    names. Empty, the broker forwards all names except hop-by-hop headers,
    `proxy-authorization`, method overrides, `x-goog-api-key` and
    `x-goog-user-project`.
  - The broker holds at most 64 MiB of request bodies at one time, across
    requests. Above that it answers 503.
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
- pi agents have a `web_search` tool (`runner/pi-extensions/web-search.ts`,
  installed root-owned at `/opt/pi-extensions/web-search.ts`). It sends the
  query to the cluster's SearXNG
  (`http://searxng.aitools.svc.cluster.local:8080/search`, JSON API) and
  returns a numbered list: title, URL, snippet and the engines that found
  each result. There is no fallback to another search service. Set
  `WEB_SEARCH_URL` in the agent's env to use another SearXNG `/search` URL.
  - Limits: a query of at most 500 characters, 1 to 10 results (default 5),
    a timeout of 15 s, titles of at most 200 characters and snippets of at
    most 500, and at most 8000 characters in total. Newlines, control
    characters and zero-width and bidi controls are removed from the result
    text, so a result cannot add lines or hide text.
  - A failure (for example "search service unavailable (HTTP 503)") is an
    error result with clear text. "No results" is a normal result.
  - The tool description tells the model that results are untrusted data,
    not instructions.
  - It does not fetch pages. To read a page, use the `web-fetch` command.
  - How it reaches a run: Paperclip's `pi_local` adapter (2026.1117.0) starts
    pi with `--tools read,bash,edit,write,grep,find,ls` (`execute.ts:670`).
    That allowlist also applies to extension tools. The adapter can also
    point `PI_CODING_AGENT_DIR` at its own directory (`execute.ts:344`,
    `:485`), so `~/.pi/agent/extensions` is not a reliable place. The pi
    wrapper (`runner/pi-slot.sh`) therefore adds `-e
    /opt/pi-extensions/web-search.ts` and adds `web_search` to a `--tools`
    list. It changes nothing for a subcommand (`pi install`), with
    `--no-extensions` or `--no-tools`, for an empty list, or after `--`. pi
    does not read `--tools=x` as a tool list, so the wrapper leaves it alone.
  - The build tests it (`runner/pi-extensions/web-search.test.mjs`): through
    pi's own loader against a stub SearXNG, and with pi started offline
    through the wrapper to check that `web_search` is an active tool.
    `runner/pi-slot.test.sh` tests the wrapper's argument changes with a stub
    in place of the real pi.
- Every agent has a `web-fetch` command (`runner/web-fetch`, installed
  root-owned at `/usr/local/bin/web-fetch`). It reads one web page through
  the cluster's web-fetch service
  (`http://web-fetch.aitools.svc.cluster.local:8080/fetch`), which renders
  the page in headless Chromium and returns its main content as Markdown.
  It is a command and not a pi tool, so pi agents (bash tool) and Claude
  Code agents (Bash) use the same one. Set `WEB_FETCH_URL` in the agent's
  env to use another `/fetch` URL (http or https only).

  ```text
  web-fetch [--max-chars N] [--timeout S] [--json] <url>
  ```

  - The URL must be `http` or `https`, at most 2048 characters, with no
    user name or password. The command encodes it. The service fetches an
    `http` URL over `https`, on port 443 only, and only from public
    addresses.
  - `--max-chars`: 1000 to 200000 characters of Markdown (the service
    default is 50000). `--timeout`: 5 to 60 seconds for the whole fetch (the
    service default is 30). The command waits 10 s longer than the fetch
    timeout for the service to answer.
  - The output is a header block (Title, URL, Final URL, Fetched at in UTC,
    Truncated), a line that says the page content is untrusted data and not
    instructions, an empty line, and the Markdown. Control characters are
    removed, so a page cannot send terminal escape sequences.
  - `--json` prints the service's JSON answer unchanged (for an error too).
  - An error is one line on stderr, with an exit code:

    | Exit | Service answer | Meaning |
    |---|---|---|
    | 0 | 200 `ok` | The page is on stdout |
    | 2 | | Usage error: a bad option, a bad URL, or a bad `WEB_FETCH_URL`. No request is sent. |
    | 3 | 400 `bad_request` | The service refused the request |
    | 4 | 403 `forbidden_target` | A non-public address, a port other than 443, or plain HTTP (also in a redirect) |
    | 5 | 413 `too_large` | The page passed 20 MiB on the wire |
    | 6 | 415 `unsupported_type` | Not HTML, plain text, Markdown, CSV or JSON: for example a PDF or an image |
    | 7 | 422 `blocked` | The site refused automated reading |
    | 8 | 502 `upstream_error` | DNS, connection or TLS failure, or an HTTP error from the site |
    | 9 | 503 `busy` | The service is busy; try again later |
    | 10 | 504 `timeout` | The page did not load in the fetch timeout |
    | 11 | | The service is unreachable, or did not answer in time |
    | 12 | | An unexpected service answer (another HTTP status, or not JSON) |

  - "blocked" means that the site refused the browser: HTTP 401, 403, 407,
    429 or 451, or a bot check such as a CAPTCHA. The service does not try
    to get around it. Use another source, or ask the owner.
  - The build tests it (`runner/web-fetch.test.mjs`): the installed command
    against a stub service, for success, truncation, each error code, a
    service that is down or hangs, bad URLs and options, and `--json`.
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
- Egress proxy (DIL-888): `/etc/profile.d` sets these variables.
  - `https_proxy` and `HTTPS_PROXY` point to the cluster's CONNECT proxy,
    `agent-egress.paperclip-agents.svc.cluster.local:3128`.
  - `no_proxy` and `NO_PROXY` cover loopback, `.svc` and `.cluster.local`.
  - `NODE_USE_ENV_PROXY=1` makes Node honour them (Node 24.0.0 and later).

  The ssh config sends git over SSH through the same proxy, with
  `ssh-proxy-connect` and OpenBSD netcat, and sends a keepalive every 10 s.
  Without `https_proxy`, for example in a job that reads no profile,
  `ssh-proxy-connect` connects directly. It refuses a proxy URL with
  credentials. The variables are defaults, not a boundary: the deployment's
  NetworkPolicy is. `agy-acp` points agy and its child processes at the
  agy-broker instead, which bypasses this proxy (DIL-993).
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
`~/.ssh/rc`. The agent user's login shell is dash, so sshd's `sh -c` reads
no startup file: with bash, `~/.bashrc` ran before every SSH command. The
dash shell protects only commands that source no profile, such as the
sandbox-ssh driver's housekeeping. Paperclip's ssh driver sources
`/etc/profile`, `~/.profile`, `~/.bash_profile` (or else `~/.bashrc`) and
`~/.zprofile` before each command. sandbox-ssh sources `/etc/profile` and
`~/.profile` before an agent's command. So a startup file that one run
writes still applies to later runs until the next restart. Python
ignores user site-packages anyway (`PYTHONNOUSERSITE`).
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
