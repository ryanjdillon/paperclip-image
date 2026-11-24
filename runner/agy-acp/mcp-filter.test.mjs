import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { filterLine } from "./mcp-filter.mjs";

const http = (name) => ({
  type: "http", name, url: "http://paperclip.paperclip.svc.cluster.local:3100/api/mcp/project-tools",
  headers: [{ name: "Authorization", value: "Bearer run-token" }],
});
const request = (method, mcpServers) =>
  JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: { cwd: "/w", mcpServers } });

test("session/new: the MCP servers go, the other params stay", () => {
  const { line, removed } = filterLine(request("session/new", [http("Paperclip projects"), http("GitHub")]));
  const out = JSON.parse(line);
  assert.deepEqual(out.params, { cwd: "/w", mcpServers: [] });
  assert.equal(out.id, 2);
  assert.equal(out.method, "session/new");
  assert.deepEqual(removed, ["Paperclip projects", "GitHub"]);
  assert.ok(!line.includes("run-token"));
});

test("session/load, session/resume and session/fork are filtered too", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const { line, removed } = filterLine(request(method, [http("Paperclip projects")]));
    assert.deepEqual(JSON.parse(line).params.mcpServers, []);
    assert.deepEqual(removed, ["Paperclip projects"]);
  }
});

test("other lines go through byte for byte", () => {
  for (const line of [
    request("session/new", []).replace("{", "{ "),
    request("session/prompt", [http("Paperclip projects")]),
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    "not json mcpServers",
    JSON.stringify({ jsonrpc: "2.0", id: 3, result: { mcpServers: [http("x")] } }),
  ]) {
    assert.deepEqual(filterLine(line), { line, removed: [] });
  }
});

test("the filter starts the server, logs only names and passes the exit code", async () => {
  const filter = fileURLToPath(new URL("./mcp-filter.mjs", import.meta.url));
  // A stand-in server: prints each line that it reads, then exits with 3.
  const echo = "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(3));";
  const child = spawn(process.execPath, [filter, process.execPath, "-e", echo]);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.stdin.end(`${request("session/new", [http("Paperclip projects")])}\nplain\n`);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 3);
  const [first, second] = out.trimEnd().split("\n");
  assert.deepEqual(JSON.parse(first).params.mcpServers, []);
  assert.equal(second, "plain");
  assert.match(err, /"Paperclip projects"/);
  assert.ok(!err.includes("run-token") && !err.includes("svc.cluster.local"));
});
