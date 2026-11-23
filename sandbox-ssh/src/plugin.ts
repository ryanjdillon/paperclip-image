import { randomUUID } from "node:crypto";
import path from "node:path";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PaperclipPlugin,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentLeaseObservation,
  PluginEnvironmentProbeResult,
  PluginEnvironmentTerminationReceipt,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { configErrors, parseConfig, type SshSandboxConfig } from "./config.js";
import { CredentialFiles, shellQuote, SshRunner, type RemoteRunner } from "./ssh.js";

export const PROVIDER = "ssh-sandbox";
/** Short limit for the driver's own housekeeping commands. */
const CONTROL_TIMEOUT_MS = 30_000;
const LEASE_ID_PATTERN = /^lease-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The lease directory. Throws for an ID that this driver did not make, so no other path is ever removed. */
export function leaseDir(config: SshSandboxConfig, providerLeaseId: string): string {
  if (!LEASE_ID_PATTERN.test(providerLeaseId)) {
    throw new Error(`Not a lease of this driver: ${providerLeaseId}`);
  }
  return path.posix.join(config.workspaceRoot, providerLeaseId);
}

/** Every command of a lease carries this variable, set to the lease ID, so stop can find its processes. */
export const LEASE_ENV = "PAPERCLIP_SANDBOX_LEASE";

/**
 * Ends every process of the login user that belongs to the lease: its working
 * directory is in the lease directory (also through a symlink), or its
 * environment has LEASE_ENV for the lease. TERM first, then KILL until none is
 * left. Exits 1 if a process is still there, so that no receipt is given for
 * work that still runs.
 */
export function stopProcessesScript(dir: string, providerLeaseId: string): string {
  return [
    `d=${shellQuote(dir)}`,
    `tag=${shellQuote(`${LEASE_ENV}=${providerLeaseId}`)}`,
    'real=$(cd "$d" 2>/dev/null && pwd -P) || real="$d"',
    "owned() {",
    '  [ -O "$1" ] || return 1',
    '  c=$(readlink "$1/cwd" 2>/dev/null) || return 1',
    '  case "$c" in "$d"|"$d"/*|"$real"|"$real"/*) return 0;; esac',
    '  grep -qzxF -- "$tag" "$1/environ" 2>/dev/null',
    "}",
    "signal_all() {",
    "  n=0",
    "  for p in /proc/[0-9]*; do",
    '    pid=${p#/proc/}',
    '    [ "$pid" = "$$" ] && continue',
    '    owned "$p" || continue',
    '    kill -"$1" "$pid" 2>/dev/null && n=$((n + 1))',
    "  done",
    "}",
    "signal_all TERM",
    '[ "$n" -eq 0 ] && exit 0',
    "sleep 2",
    "for round in 1 2 3 4 5; do",
    "  signal_all KILL",
    '  [ "$n" -eq 0 ] && exit 0',
    "  sleep 1",
    "done",
    'echo "processes of the lease are still running" >&2',
    "exit 1",
  ].join("\n");
}

function leaseMetadata(config: SshSandboxConfig, remoteCwd: string, resumedLease: boolean) {
  return {
    provider: PROVIDER,
    shellCommand: "bash",
    host: config.host,
    port: config.port,
    username: config.username,
    workspaceRoot: config.workspaceRoot,
    remoteCwd,
    resumedLease,
  };
}

function runtimeConfig(raw: Record<string, unknown>): SshSandboxConfig {
  const config = parseConfig(raw);
  const errors = configErrors(config);
  if (errors.length > 0) throw new Error(`Invalid SSH sandbox config: ${errors.join(" ")}`);
  return config;
}

function describe(result: { exitCode: number | null; timedOut: boolean; stderr: string }): string {
  if (result.timedOut) return "timed out";
  return `exit ${result.exitCode}: ${result.stderr.trim() || "no output"}`;
}

export function createPlugin(runner: RemoteRunner, newId: () => string = randomUUID): PaperclipPlugin {
  async function control(config: SshSandboxConfig, script: string) {
    return await runner.run(config, {
      command: "sh",
      args: ["-c", script],
      timeoutMs: CONTROL_TIMEOUT_MS,
      profiles: false,
    });
  }

  async function mustControl(config: SshSandboxConfig, script: string, what: string) {
    const result = await control(config, script);
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`SSH sandbox could not ${what} (${describe(result)}).`);
    }
    return result;
  }

  async function makeDir(config: SshSandboxConfig, dir: string) {
    await mustControl(config, `umask 077 && mkdir -p ${shellQuote(dir)}`, `create ${dir}`);
  }

  async function endLease(
    rawConfig: Record<string, unknown>,
    providerLeaseId: string | null,
    retain: boolean,
  ): Promise<PluginEnvironmentTerminationReceipt | void> {
    if (!providerLeaseId) return;
    const config = runtimeConfig(rawConfig);
    const dir = leaseDir(config, providerLeaseId);
    await mustControl(config, stopProcessesScript(dir, providerLeaseId), `stop the processes of ${providerLeaseId}`);
    if (retain) return { providerLeaseId, state: "stopped" };
    await mustControl(config, `rm -rf -- ${shellQuote(dir)}`, `remove ${dir}`);
    return { providerLeaseId, state: "destroyed" };
  }

  return definePlugin({
    async setup(ctx) {
      ctx.logger.info("SSH sandbox provider ready");
    },

    async onHealth() {
      return { status: "ok", message: "SSH sandbox provider healthy" };
    },

    async onEnvironmentValidateConfig(params): Promise<PluginEnvironmentValidationResult> {
      // At save time the key can still be a secret binding object, not a string.
      const keyGiven = params.config.privateKey != null && params.config.privateKey !== "";
      const config = parseConfig({ ...params.config, privateKey: keyGiven ? "given" : "" });
      const errors = configErrors(config);
      if (errors.length > 0) return { ok: false, errors };
      const { privateKey: _key, ...normalized } = config;
      return { ok: true, normalizedConfig: { ...params.config, ...normalized } };
    },

    async onEnvironmentProbe(params): Promise<PluginEnvironmentProbeResult> {
      const config = runtimeConfig(params.config);
      const metadata = { provider: PROVIDER, host: config.host, port: config.port, username: config.username };
      try {
        const result = await control(
          config,
          `umask 077 && mkdir -p ${shellQuote(config.workspaceRoot)} && uname -sm && command -v bash node`,
        );
        if (result.timedOut || result.exitCode !== 0) {
          return {
            ok: false,
            summary: `SSH sandbox probe failed on ${config.host} (${describe(result)}).`,
            metadata,
          };
        }
        return {
          ok: true,
          summary: `Connected to ${config.username}@${config.host}:${config.port}.`,
          metadata: { ...metadata, system: result.stdout.trim().split("\n")[0] },
        };
      } catch (error) {
        return {
          ok: false,
          summary: `SSH sandbox probe failed on ${config.host}.`,
          metadata: { ...metadata, error: error instanceof Error ? error.message : String(error) },
        };
      }
    },

    async onEnvironmentAcquireLease(params): Promise<PluginEnvironmentLease> {
      const config = runtimeConfig(params.config);
      const providerLeaseId = `lease-${newId()}`;
      const remoteCwd = leaseDir(config, providerLeaseId);
      await makeDir(config, remoteCwd);
      return { providerLeaseId, metadata: leaseMetadata(config, remoteCwd, false) };
    },

    async onEnvironmentResumeLease(params): Promise<PluginEnvironmentLease> {
      const config = runtimeConfig(params.config);
      const remoteCwd = leaseDir(config, params.providerLeaseId);
      const result = await control(config, `test -d ${shellQuote(remoteCwd)}`);
      if (result.exitCode === 1) return { providerLeaseId: null, metadata: { expired: true } };
      if (result.timedOut || result.exitCode !== 0) {
        // A transport failure must keep the lease and its files: release or destroy own cleanup.
        throw new Error(`SSH sandbox could not check ${params.providerLeaseId} (${describe(result)}).`);
      }
      return { providerLeaseId: params.providerLeaseId, metadata: leaseMetadata(config, remoteCwd, true) };
    },

    async onEnvironmentReleaseLease(params) {
      return await endLease(params.config, params.providerLeaseId, params.resourceDisposition === "stop_and_retain");
    },

    async onEnvironmentStopLease(params): Promise<PluginEnvironmentTerminationReceipt> {
      if (!params.providerLeaseId) throw new Error("No provider lease ID to stop.");
      return (await endLease(params.config, params.providerLeaseId, true))!;
    },

    async onEnvironmentDestroyLease(params) {
      return await endLease(params.config, params.providerLeaseId, false);
    },

    async onEnvironmentInspectLease(params): Promise<PluginEnvironmentLeaseObservation> {
      const config = runtimeConfig(params.config);
      const remoteCwd = leaseDir(config, params.providerLeaseId);
      const result = await control(config, `test -d ${shellQuote(remoteCwd)}`);
      if (result.exitCode === 0) return { providerLeaseId: params.providerLeaseId, state: "active" };
      if (result.exitCode === 1) return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw new Error(`SSH sandbox could not inspect ${params.providerLeaseId} (${describe(result)}).`);
    },

    async onEnvironmentRealizeWorkspace(params) {
      const config = runtimeConfig(params.config);
      if (!params.lease.providerLeaseId) throw new Error("No provider lease ID to realize a workspace in.");
      const remoteCwd = leaseDir(config, params.lease.providerLeaseId);
      await makeDir(config, remoteCwd);
      return { cwd: remoteCwd, metadata: { provider: PROVIDER, remoteCwd } };
    },

    async onEnvironmentExecute(params): Promise<PluginEnvironmentExecuteResult> {
      if (!params.lease.providerLeaseId) {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "No provider lease ID available for execution." };
      }
      const config = runtimeConfig(params.config);
      const result = await runner.run(config, {
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd ?? leaseDir(config, params.lease.providerLeaseId),
        env: { ...params.env, [LEASE_ENV]: params.lease.providerLeaseId },
        stdin: params.stdin,
        timeoutMs: params.timeoutMs ?? config.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  });
}

export default createPlugin(new SshRunner(new CredentialFiles().disposeOnExit()));
