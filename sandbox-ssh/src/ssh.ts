import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SshSandboxConfig } from "./config.js";

/** The most output kept from one stream of one command. More output ends the command. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** How long after the remote time limit the local ssh process is killed. */
export const LOCAL_TIMEOUT_GRACE_MS = 15_000;
/** Exit status of coreutils `timeout` when the limit expires. */
const TIMEOUT_EXIT_CODE = 124;

export interface RemoteCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

export interface RemoteResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Runs one command on the SSH server. */
export interface RemoteRunner {
  run(config: SshSandboxConfig, command: RemoteCommand): Promise<RemoteResult>;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds the script that the server's `sh` runs. It reads the login profiles
 * first, so a command finds the same PATH as in a login shell; the runner puts
 * node and the agent CLIs on PATH there. The host's env comes after the
 * profiles, so it wins over anything a profile exports. coreutils `timeout`
 * ends the command on the server too, because killing the local ssh process
 * does not stop a remote command that has no TTY.
 */
export function buildRemoteScript(command: RemoteCommand): string {
  const env = Object.entries(command.env ?? {});
  for (const [key] of env) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }
  const seconds = Math.max(1, Math.ceil(command.timeoutMs / 1000));
  const words = [
    "exec",
    "timeout",
    "--kill-after=10s",
    `${seconds}s`,
    "env",
    ...env.map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(command.command),
    ...(command.args ?? []).map(shellQuote),
  ];
  return [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    ...(command.cwd ? [`cd ${shellQuote(command.cwd)}`] : []),
    words.join(" "),
  ].join(" && ");
}

/** Writes the key and known_hosts to private files, one pair for each distinct config. */
export class CredentialFiles {
  #dir: Promise<string> | null = null;
  #written = new Map<string, Promise<{ identityFile: string; knownHostsFile: string }>>();

  constructor(private readonly tmpdir: string = os.tmpdir()) {}

  files(config: SshSandboxConfig): Promise<{ identityFile: string; knownHostsFile: string }> {
    const id = createHash("sha256")
      .update(config.privateKey)
      .update("\0")
      .update(config.knownHosts)
      .digest("hex")
      .slice(0, 16);
    let files = this.#written.get(id);
    if (!files) {
      files = this.#write(id, config);
      this.#written.set(id, files);
      files.catch(() => this.#written.delete(id));
    }
    return files;
  }

  async #write(id: string, config: SshSandboxConfig) {
    // mkdtemp makes the directory 0700, so only this process's user can read the key.
    this.#dir ??= mkdtemp(path.join(this.tmpdir, "paperclip-sandbox-ssh-"));
    const dir = await this.#dir;
    const identityFile = path.join(dir, `${id}.key`);
    const knownHostsFile = path.join(dir, `${id}.known_hosts`);
    await writeFile(identityFile, config.privateKey, { mode: 0o600 });
    await writeFile(knownHostsFile, `${config.knownHosts}\n`, { mode: 0o600 });
    return { identityFile, knownHostsFile };
  }

  async dispose(): Promise<void> {
    const dir = this.#dir;
    this.#dir = null;
    this.#written.clear();
    if (dir) await rm(await dir, { recursive: true, force: true });
  }
}

/** The ssh arguments, without the remote command. Only the given files are read: no config, no agent. */
export function sshArgs(
  config: SshSandboxConfig,
  files: { identityFile: string; knownHostsFile: string },
): string[] {
  const options = {
    BatchMode: "yes",
    ConnectTimeout: "10",
    StrictHostKeyChecking: "yes",
    UserKnownHostsFile: files.knownHostsFile,
    GlobalKnownHostsFile: "/dev/null",
    UpdateHostKeys: "no",
    IdentitiesOnly: "yes",
    IdentityFile: files.identityFile,
    IdentityAgent: "none",
    ClearAllForwardings: "yes",
    ServerAliveInterval: "30",
    ServerAliveCountMax: "4",
    LogLevel: "ERROR",
  };
  return [
    "-F",
    "/dev/null",
    "-T",
    ...Object.entries(options).flatMap(([key, value]) => ["-o", `${key}=${value}`]),
    "-p",
    String(config.port),
    "-l",
    config.username,
    "--",
    config.host,
  ];
}

type Spawn = typeof nodeSpawn;

/** Runs commands with the local `ssh` client. */
export class SshRunner implements RemoteRunner {
  constructor(
    private readonly credentials: CredentialFiles = new CredentialFiles(),
    private readonly spawn: Spawn = nodeSpawn,
  ) {}

  async run(config: SshSandboxConfig, command: RemoteCommand): Promise<RemoteResult> {
    const script = buildRemoteScript(command);
    const files = await this.credentials.files(config);
    const args = [...sshArgs(config, files), `sh -c ${shellQuote(script)}`];
    const started = Date.now();

    return await new Promise<RemoteResult>((resolve, reject) => {
      const child = this.spawn("ssh", args, {
        stdio: [command.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const size = { stdout: 0, stderr: 0 };
      let localTimeout = false;
      let overflow = false;
      let settled = false;

      const timer = setTimeout(() => {
        localTimeout = true;
        child.kill("SIGKILL");
      }, command.timeoutMs + LOCAL_TIMEOUT_GRACE_MS);

      const collect = (name: "stdout" | "stderr", chunks: Buffer[]) => (chunk: Buffer) => {
        size[name] += chunk.length;
        if (size[name] > MAX_OUTPUT_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on("data", collect("stdout", stdout));
      child.stderr?.on("data", collect("stderr", stderr));

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (overflow) {
          reject(new Error(`Remote command wrote more than ${MAX_OUTPUT_BYTES} bytes to one stream.`));
          return;
        }
        const remoteTimeout = code === TIMEOUT_EXIT_CODE && Date.now() - started >= command.timeoutMs;
        const timedOut = localTimeout || remoteTimeout;
        resolve({
          exitCode: timedOut ? null : code,
          signal: localTimeout ? null : signal,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });

      if (command.stdin != null && child.stdin) {
        // The remote command can exit before it reads all of stdin.
        child.stdin.on("error", () => undefined);
        child.stdin.end(command.stdin);
      }
    });
  }
}
