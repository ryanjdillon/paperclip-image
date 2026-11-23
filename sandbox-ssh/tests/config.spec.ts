import { describe, expect, it } from "vitest";
import { configErrors, DEFAULT_PORT, DEFAULT_TIMEOUT_MS, DEFAULT_WORKSPACE_ROOT, parseConfig } from "../src/config.js";

const valid = {
  host: "agent-runner.paperclip-agents.svc",
  port: 2222,
  username: "node",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
  knownHosts: "[agent-runner]:2222 ssh-ed25519 AAAA",
};

describe("parseConfig", () => {
  it("fills the defaults", () => {
    const config = parseConfig({ host: "h", username: "u", privateKey: "k", knownHosts: "x" });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("ends the key with one newline and drops a trailing slash from the root", () => {
    const config = parseConfig({ ...valid, privateKey: "key\n\n", workspaceRoot: "/srv/sandbox/" });
    expect(config.privateKey).toBe("key\n");
    expect(config.workspaceRoot).toBe("/srv/sandbox");
  });
});

describe("configErrors", () => {
  it("accepts a valid config", () => {
    expect(configErrors(parseConfig(valid))).toEqual([]);
  });

  it.each([
    ["host", { host: "-oProxyCommand=x" }, "host"],
    ["host", { host: "a b" }, "host"],
    ["port", { port: 0 }, "port"],
    ["port", { port: "x" }, "port"],
    ["username", { username: "-l" }, "username"],
    ["privateKey", { privateKey: "" }, "privateKey"],
    ["knownHosts", { knownHosts: " " }, "knownHosts"],
    ["workspaceRoot", { workspaceRoot: "relative" }, "workspaceRoot"],
    ["workspaceRoot", { workspaceRoot: "/" }, "workspaceRoot"],
    ["workspaceRoot", { workspaceRoot: "/a/../b" }, "workspaceRoot"],
    ["timeoutMs", { timeoutMs: 0 }, "timeoutMs"],
  ])("refuses a bad %s", (_name, change, field) => {
    const errors = configErrors(parseConfig({ ...valid, ...change }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(field);
  });
});
