import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { MAX_TIMEOUT_MS } from "../src/config.js";
import {
  buildRemoteScript,
  clampTimeout,
  CredentialFiles,
  LOCAL_TIMEOUT_GRACE_MS,
  MAX_OUTPUT_BYTES,
  shellQuote,
  sshArgs,
  SshRunner,
  TRUSTED_PATH,
} from "../src/ssh.js";

const config = parseConfig({
  host: "runner",
  port: 2222,
  username: "node",
  privateKey: "KEY",
  knownHosts: "[runner]:2222 ssh-ed25519 AAAA",
});

describe("shellQuote", () => {
  it("survives a round trip through sh", async () => {
    const value = `a 'b' "c" $HOME \`x\` \\ \n end`;
    const local = new SshRunner(new CredentialFiles(), localSpawn);
    const result = await local.run(config, { command: "printf", args: ["%s", value], timeoutMs: 5000 });
    expect(result.stdout).toBe(value);
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });
});

describe("buildRemoteScript", () => {
  it("refuses an env name that is not a shell name", () => {
    expect(() => buildRemoteScript({ command: "x", env: { "A;B": "1" }, timeoutMs: 1000 })).toThrow(/A;B/);
  });

  it("rounds the time limit up to whole seconds", () => {
    expect(buildRemoteScript({ command: "x", timeoutMs: 1001 })).toContain("timeout --kill-after=10s 2s env -- 'x'");
  });

  it("reads no profile and sets a fixed PATH for housekeeping", () => {
    const script = buildRemoteScript({ command: "rm", timeoutMs: 1000, profiles: false });
    expect(script.startsWith(`PATH=${TRUSTED_PATH} && export PATH && `)).toBe(true);
    expect(script.endsWith("; exit $?")).toBe(true);
    expect(script).not.toContain(".profile");
  });

  it("clamps the time limit", () => {
    expect(clampTimeout(10 ** 12)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimeout(0)).toBe(1);
  });
});

describe("sshArgs", () => {
  it("reads only the given files and checks the host key", () => {
    const args = sshArgs(config, { identityFile: "/k", knownHostsFile: "/h" });
    expect(args.slice(0, 3)).toEqual(["-F", "/dev/null", "-T"]);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=/h");
    expect(args).toContain("IdentityFile=/k");
    expect(args).toContain("IdentityAgent=none");
    expect(args.slice(-6)).toEqual(["-p", "2222", "-l", "node", "--", "runner"]);
  });
});

describe("CredentialFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sandbox-ssh-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes private files once for each config and removes them", async () => {
    const credentials = new CredentialFiles(dir);
    const first = await credentials.files(config);
    const again = await credentials.files(config);
    expect(again).toEqual(first);
    expect(await readFile(first.identityFile, "utf8")).toBe("KEY\n");
    expect((await stat(first.identityFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first.identityFile))).mode & 0o777).toBe(0o700);
    const other = await credentials.files({ ...config, privateKey: "OTHER\n" });
    expect(other.identityFile).not.toBe(first.identityFile);
    await credentials.dispose();
    await expect(stat(path.dirname(first.identityFile))).rejects.toThrow();
  });
});

// Runs the remote command that ssh would send (its last argument) with the local sh.
const localSpawn = ((_file: string, args: readonly string[], options: object) =>
  spawn("sh", ["-c", args[args.length - 1]!], options)) as typeof spawn;

describe("SshRunner", () => {
  let credentials: CredentialFiles;
  let runner: SshRunner;
  beforeEach(() => {
    credentials = new CredentialFiles();
    runner = new SshRunner(credentials, localSpawn);
  });
  afterEach(async () => {
    await credentials.dispose();
  });

  it("passes args, env and cwd, and returns the exit code", async () => {
    const result = await runner.run(config, {
      command: "sh",
      args: ["-c", 'printf "%s|%s|%s" "$1" "$GREETING" "$(pwd)"; echo err >&2; exit 3', "_", "a b"],
      env: { GREETING: "hi 'there'" },
      cwd: "/tmp",
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      exitCode: 3,
      signal: null,
      timedOut: false,
      stdout: "a b|hi 'there'|/tmp",
      stderr: "err\n",
    });
  });

  it("feeds stdin", async () => {
    const result = await runner.run(config, { command: "cat", stdin: "line 1\nline 2\n", timeoutMs: 5000 });
    expect(result.stdout).toBe("line 1\nline 2\n");
    expect(result.exitCode).toBe(0);
  });

  it("gives a command without stdin an empty stdin", async () => {
    const result = await runner.run(config, { command: "cat", timeoutMs: 5000 });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("reports a time limit that expires", async () => {
    const result = await runner.run(config, { command: "sleep", args: ["5"], timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 10_000);

  it("reports a timeout when the command ignores TERM", async () => {
    const result = await runner.run(config, {
      command: "sh",
      args: ["-c", "trap '' TERM; sleep 30"],
      timeoutMs: 1000,
    });
    expect(result.timedOut).toBe(true);
  }, 20_000);

  it("returns at the local limit when a process still holds the pipes", async () => {
    // A stand-in for ssh whose remote side never stops: only the local kill ends the run.
    const stuck = ((_file: string, _args: readonly string[], options: object) =>
      spawn("sh", ["-c", "sleep 25 & wait"], options)) as typeof spawn;
    const started = Date.now();
    const result = await new SshRunner(credentials, stuck).run(config, { command: "true", timeoutMs: 1 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(LOCAL_TIMEOUT_GRACE_MS + 3000);
  }, 25_000);

  it("ends a command with too much output", async () => {
    await expect(
      runner.run(config, { command: "head", args: ["-c", String(MAX_OUTPUT_BYTES + 1), "/dev/zero"], timeoutMs: 5000 }),
    ).rejects.toThrow(/bytes of output/);
  });

  it("runs a command whose name looks like an option", async () => {
    const result = await runner.run(config, { command: "-S", timeoutMs: 5000 });
    expect(result.exitCode).toBe(127);
  });

  it("does not call a command that exits 124 at once a timeout", async () => {
    const result = await runner.run(config, { command: "sh", args: ["-c", "exit 124"], timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(124);
  });
});
