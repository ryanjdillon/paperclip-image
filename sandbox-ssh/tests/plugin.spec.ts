import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPlugin, LEASE_ENV, leaseDir, PROVIDER, stopProcessesScript } from "../src/plugin.js";
import { parseConfig, type SshSandboxConfig } from "../src/config.js";
import type { RemoteCommand, RemoteResult, RemoteRunner } from "../src/ssh.js";

const rawConfig = {
  host: "runner",
  port: 2222,
  username: "node",
  privateKey: "KEY",
  knownHosts: "[runner]:2222 ssh-ed25519 AAAA",
  workspaceRoot: "/home/node/paperclip-sandbox",
};
const config = parseConfig(rawConfig);
const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
const leaseId = `lease-${id}`;
const remoteCwd = `/home/node/paperclip-sandbox/${leaseId}`;
const base = { driverKey: "ssh-sandbox", companyId: "c", environmentId: "e", config: rawConfig };

function ok(stdout = ""): RemoteResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
}

/** Records each command and answers with the next queued result, or success. */
class RecordingRunner implements RemoteRunner {
  calls: Array<{ config: SshSandboxConfig; command: RemoteCommand }> = [];
  constructor(private readonly results: RemoteResult[] = []) {}
  async run(config: SshSandboxConfig, command: RemoteCommand) {
    this.calls.push({ config, command });
    return this.results.shift() ?? ok();
  }
  scripts() {
    return this.calls.map((call) => call.command.args?.[1]);
  }
}

function setup(results: RemoteResult[] = []) {
  const runner = new RecordingRunner(results);
  const plugin = createPlugin(runner, () => id).definition;
  return { runner, plugin };
}

describe("leaseDir", () => {
  it("refuses an ID that this driver did not make", () => {
    expect(() => leaseDir(config, "../..")).toThrow(/Not a lease/);
    expect(() => leaseDir(config, `lease-${id}/x`)).toThrow(/Not a lease/);
    expect(leaseDir(config, leaseId)).toBe(remoteCwd);
  });
});

describe("stopProcessesScript", () => {
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));

  it("ends the lease's processes, through a symlink, by cwd or by tag, and no others", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-ssh-stop-"));
    const real = path.join(root, "real");
    const linked = path.join(root, "linked");
    await mkdir(path.join(real, leaseId, "sub"), { recursive: true });
    await mkdir(path.join(real, `${leaseId}-other`));
    await symlink(real, linked);
    const dir = path.join(linked, leaseId);
    const tagged = { ...process.env, [LEASE_ENV]: leaseId };
    const inside = spawn("sleep", ["30"], { cwd: path.join(dir, "sub"), stdio: "ignore" });
    const moved = spawn("sleep", ["30"], { cwd: os.tmpdir(), env: tagged, stdio: "ignore" });
    const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { cwd: dir, stdio: "ignore" });
    const bystander = spawn("sleep", ["30"], { cwd: path.join(real, `${leaseId}-other`), stdio: "ignore" });
    const otherTag = spawn("sleep", ["30"], {
      cwd: os.tmpdir(),
      env: { ...process.env, [LEASE_ENV]: `${leaseId}x` },
      stdio: "ignore",
    });
    const ends = [exited(inside), exited(moved), exited(stubborn)];
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = spawnSync("sh", ["-c", stopProcessesScript(dir, leaseId)], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(await Promise.all(ends)).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
      expect(bystander.exitCode ?? bystander.signalCode).toBeNull();
      expect(otherTag.exitCode ?? otherTag.signalCode).toBeNull();
    } finally {
      for (const child of [inside, moved, stubborn, bystander, otherTag]) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits at once when nothing runs", () => {
    const result = spawnSync("sh", ["-c", stopProcessesScript("/nonexistent/lease", leaseId)], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});

describe("validate config", () => {
  it("keeps a secret binding for the key as given", async () => {
    const { plugin } = setup();
    const result = await plugin.onEnvironmentValidateConfig!({
      driverKey: "ssh-sandbox",
      config: { ...rawConfig, privateKey: { type: "secret_ref", secretId: "s", version: "latest" } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig?.privateKey).toEqual({ type: "secret_ref", secretId: "s", version: "latest" });
    expect(result.normalizedConfig?.port).toBe(2222);
  });

  it("reports what is wrong", async () => {
    const { plugin } = setup();
    const result = await plugin.onEnvironmentValidateConfig!({
      driverKey: "ssh-sandbox",
      config: { ...rawConfig, knownHosts: "" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toContain("knownHosts");
  });
});

describe("probe", () => {
  it("reports success with the system line", async () => {
    const { plugin } = setup([ok("Linux x86_64\n/usr/bin/bash\n")]);
    const result = await plugin.onEnvironmentProbe!(base);
    expect(result.ok).toBe(true);
    expect(result.metadata?.system).toBe("Linux x86_64");
  });

  it("reports a failed command", async () => {
    const { plugin } = setup([{ ...ok(), exitCode: 255, stderr: "Host key verification failed." }]);
    const result = await plugin.onEnvironmentProbe!(base);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Host key verification failed.");
  });
});

describe("leases", () => {
  it("acquires a private directory for each lease", async () => {
    const { plugin, runner } = setup();
    const lease = await plugin.onEnvironmentAcquireLease!({ ...base, runId: "r" });
    expect(lease.providerLeaseId).toBe(leaseId);
    expect(lease.metadata).toMatchObject({ provider: PROVIDER, shellCommand: "bash", remoteCwd });
    expect(runner.scripts()).toEqual([`umask 077 && mkdir -p '${remoteCwd}'`]);
    // Housekeeping never reads the profiles that every lease can write.
    expect(runner.calls[0]!.command.profiles).toBe(false);
  });

  it("resumes a lease whose directory exists, and expires one whose directory is gone", async () => {
    const { plugin } = setup([ok(), { ...ok(), exitCode: 1 }]);
    const resumed = await plugin.onEnvironmentResumeLease!({ ...base, providerLeaseId: leaseId });
    expect(resumed).toMatchObject({ providerLeaseId: leaseId, metadata: { resumedLease: true } });
    const expired = await plugin.onEnvironmentResumeLease!({ ...base, providerLeaseId: leaseId });
    expect(expired).toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("keeps a lease when the check cannot reach the server", async () => {
    const { plugin } = setup([{ ...ok(), exitCode: 255, stderr: "Connection refused" }]);
    await expect(plugin.onEnvironmentResumeLease!({ ...base, providerLeaseId: leaseId })).rejects.toThrow(
      /Connection refused/,
    );
  });

  it("stops the processes, then removes the directory on release", async () => {
    const { plugin, runner } = setup();
    const receipt = await plugin.onEnvironmentReleaseLease!({ ...base, providerLeaseId: leaseId });
    expect(receipt).toEqual({ providerLeaseId: leaseId, state: "destroyed" });
    expect(runner.scripts()).toEqual([stopProcessesScript(remoteCwd, leaseId), `rm -rf -- '${remoteCwd}'`]);
  });

  it("keeps the files for stop_and_retain and for stop", async () => {
    const { plugin, runner } = setup();
    const retained = await plugin.onEnvironmentReleaseLease!({
      ...base,
      providerLeaseId: leaseId,
      resourceDisposition: "stop_and_retain",
    });
    const stopped = await plugin.onEnvironmentStopLease!({ ...base, providerLeaseId: leaseId });
    expect(retained).toEqual({ providerLeaseId: leaseId, state: "stopped" });
    expect(stopped).toEqual({ providerLeaseId: leaseId, state: "stopped" });
    expect(runner.scripts()).toEqual([stopProcessesScript(remoteCwd, leaseId), stopProcessesScript(remoteCwd, leaseId)]);
  });

  it("does not remove the directory when the processes could not be stopped", async () => {
    const { plugin, runner } = setup([{ ...ok(), timedOut: true, exitCode: null }]);
    await expect(plugin.onEnvironmentDestroyLease!({ ...base, providerLeaseId: leaseId })).rejects.toThrow(/timed out/);
    expect(runner.calls).toHaveLength(1);
  });

  it("refuses to remove a directory outside the workspace root", async () => {
    const { plugin, runner } = setup();
    await expect(plugin.onEnvironmentDestroyLease!({ ...base, providerLeaseId: "lease-../../x" })).rejects.toThrow(
      /Not a lease/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("inspects a lease", async () => {
    const { plugin } = setup([ok(), { ...ok(), exitCode: 1 }, { ...ok(), exitCode: 255 }]);
    const inspect = () => plugin.onEnvironmentInspectLease!({ ...base, providerLeaseId: leaseId });
    expect((await inspect()).state).toBe("active");
    expect((await inspect()).state).toBe("destroyed");
    await expect(inspect()).rejects.toThrow(/exit 255/);
  });
});

describe("execute", () => {
  const lease = { providerLeaseId: leaseId, metadata: { remoteCwd } };

  it("runs in the lease directory with the host's env, stdin and time limit", async () => {
    const { plugin, runner } = setup([{ ...ok("out"), exitCode: 2, stderr: "err" }]);
    const result = await plugin.onEnvironmentExecute!({
      ...base,
      lease,
      command: "agy-acp",
      args: ["--x"],
      env: { A: "1" },
      stdin: "in",
      timeoutMs: 1234,
    });
    expect(result).toEqual({ exitCode: 2, signal: null, timedOut: false, stdout: "out", stderr: "err" });
    expect(runner.calls[0]!.command).toEqual({
      command: "agy-acp",
      args: ["--x"],
      cwd: remoteCwd,
      env: { A: "1", [LEASE_ENV]: leaseId },
      stdin: "in",
      timeoutMs: 1234,
    });
  });

  it("uses the host's cwd and the config's time limit", async () => {
    const { plugin, runner } = setup();
    await plugin.onEnvironmentExecute!({ ...base, lease, command: "pwd", cwd: "/elsewhere" });
    expect(runner.calls[0]!.command).toMatchObject({ cwd: "/elsewhere", timeoutMs: config.timeoutMs });
  });

  it("fails without a lease ID", async () => {
    const { plugin, runner } = setup();
    const result = await plugin.onEnvironmentExecute!({ ...base, lease: { providerLeaseId: null }, command: "pwd" });
    expect(result.exitCode).toBe(1);
    expect(runner.calls).toHaveLength(0);
  });
});
