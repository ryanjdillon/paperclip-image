# sandbox-ssh

A Paperclip sandbox provider plugin (`ryanjdillon.sandbox-ssh`, driver
`ssh-sandbox`). It runs a sandbox environment on an SSH server that already
exists, for example the agent runner in `runner/`. It makes no sandboxes.

## Why

Paperclip's ACP engines for some adapters, for example `gemini_local`, run
only on a sandbox environment that has a runner
(`packages/adapters/gemini-local/src/server/acp.ts` in Paperclip
2026.1117.0). An `ssh` environment is not a sandbox, so those agents cannot
run on the agent runner. For a sandbox environment, Paperclip runs every
command through the provider's execute hook. This includes the commands of
its process-session bridge. This plugin sends those commands over SSH.

## How it works

- Each lease gets its own directory, `<workspaceRoot>/lease-<uuid>`, made with
  mode 0700. Commands run there unless the host gives another cwd.
- Each command is one `ssh` exec. The remote script reads the login profiles
  for PATH, then runs the command with `timeout` and the host's env.
- `ssh` reads only the key and `known_hosts` from the config. It uses no
  config file and no agent, and it always checks the host key. The plugin
  writes the key to a 0600 file in a 0700 directory, one for each key.
- Stop and release end every process whose working directory is in the lease
  directory, first with TERM and then with KILL. A release then removes the
  directory. `stop_and_retain` keeps it.
- A lease outlives a restart of the server. A restart of the SSH server keeps
  the lease directory only if it is on a persistent volume.

## Limits

- All leases run as one user, so a lease is not isolated from another lease.
  This is the same as for an `ssh` environment.
- The host's env goes on the `ssh` command line, the same as for Paperclip's
  `ssh` environment. Processes on the server and on the SSH server can see
  it.
- Every command opens a new SSH connection, because the runner's sshd allows
  one session for each connection (`MaxSessions 1`). On a local runner, one
  exec took about 130 ms.

## Config

| Field | Default | Meaning |
|---|---|---|
| `host` | | SSH server name or address |
| `port` | 22 | SSH port (2222 on the runner) |
| `username` | | User to log in as (`node` on the runner) |
| `privateKey` | | Secret reference to the OpenSSH private key |
| `knownHosts` | | `known_hosts` lines for the server, for example `[host]:2222 ssh-ed25519 AAAA…` |
| `workspaceRoot` | `/home/node/paperclip-sandbox` | Directory for the lease directories |
| `timeoutMs` | 3600000 | Time limit for one command when the host gives none |

## Build and install

The worker bundle includes the SDK, so `package.json` and `dist/` are the
whole plugin. CI publishes them as `ghcr.io/ryanjdillon/paperclip-sandbox-ssh`,
a `FROM scratch` image with the two at its root. The server image copies them
in:

```dockerfile
COPY --from=ghcr.io/ryanjdillon/paperclip-sandbox-ssh@sha256:… / /opt/paperclip-plugins/sandbox-ssh/
```

Then install it as a local path, for example with
`POST /api/plugins/install` and
`{"packageName": "/opt/paperclip-plugins/sandbox-ssh", "isLocalPath": true}`.

The SDK pin in `package.json` must match the Paperclip release of the server.

```sh
pnpm install --frozen-lockfile
just check   # typecheck, tests, audit
just build   # dist/
```
