import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { filterLine } from "./mcp-filter.mjs";

const filter = fileURLToPath(new URL("./mcp-filter.mjs", import.meta.url));
const remote = (name, type = "http") => ({
  type, name, url: "http://paperclip.paperclip.svc.cluster.local:3100/api/mcp/project-tools",
  headers: [{ name: "Authorization", value: "Bearer run-token" }],
});
const stdio = (name) => ({ name, command: "/bin/true", args: [], env: [] });
const request = (method, mcpServers) =>
  JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: { cwd: "/w", mcpServers } });

// Starts the filter in front of a stand-in server written in JavaScript.
function startFilter(serverScript) {
  const child = spawn(process.execPath, [filter, process.execPath, "-e", serverScript]);
  const result = { out: "", err: "" };
  child.stdout.on("data", (chunk) => { result.out += chunk; });
  child.stderr.on("data", (chunk) => { result.err += chunk; });
  result.exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, result };
}
// A stand-in server: prints each line that it reads, then exits with 3.
const ECHO = "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(3));";

test("session/new: HTTP and SSE servers go, the other params stay", () => {
  const { line, removed } = filterLine(
    request("session/new", [remote("Paperclip projects"), remote("events", "sse")]),
  );
  const out = JSON.parse(line);
  assert.deepEqual(out.params, { cwd: "/w", mcpServers: [] });
  assert.equal(out.id, 2);
  assert.equal(out.method, "session/new");
  assert.deepEqual(removed, ["Paperclip projects", "events"]);
  assert.ok(!line.includes("run-token"));
});

test("stdio servers stay", () => {
  const { line, removed } = filterLine(request("session/new", [stdio("local"), remote("paperclip-assigned")]));
  assert.deepEqual(JSON.parse(line).params.mcpServers, [stdio("local")]);
  assert.deepEqual(removed, ["paperclip-assigned"]);
  const only = request("session/new", [stdio("local")]);
  assert.deepEqual(filterLine(only), { line: only, removed: [] });
});

test("session/load, session/resume and session/fork are filtered too", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const { line, removed } = filterLine(request(method, [remote("Paperclip projects")]));
    assert.deepEqual(JSON.parse(line).params.mcpServers, []);
    assert.deepEqual(removed, ["Paperclip projects"]);
  }
});

test("other lines go through byte for byte", () => {
  for (const line of [
    request("session/new", []).replace("{", "{ "),
    request("session/prompt", [remote("Paperclip projects")]),
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"session/new","mcpServers":[]}',
    '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"mcpServers":{"name":"x y"}}}',
    '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"mcpServers":null}}',
    "not json mcpServers",
    JSON.stringify({ jsonrpc: "2.0", id: 3, result: { mcpServers: [remote("x")] } }),
  ]) {
    assert.deepEqual(filterLine(line), { line, removed: [] });
  }
});

test("the filter starts the server, logs only names and passes the exit code", async () => {
  const { child, result } = startFilter(ECHO);
  child.stdin.end(`${request("session/new", [remote("Paperclip projects")])}\nplain\n`);
  assert.deepEqual(await result.exit, { code: 3, signal: null });
  const [first, second] = result.out.trimEnd().split("\n");
  assert.deepEqual(JSON.parse(first).params.mcpServers, []);
  assert.equal(second, "plain");
  assert.match(result.err, /"Paperclip projects"/);
  assert.ok(!result.err.includes("run-token") && !result.err.includes("svc.cluster.local"));
});

test("a last line without a newline reaches the server", async () => {
  const { child, result } = startFilter(ECHO);
  child.stdin.end(`first\n${request("session/new", [remote("Paperclip projects")])}`);
  assert.equal((await result.exit).code, 3);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]).params.mcpServers, []);
});

test("SIGTERM reaches the server", async () => {
  const { child, result } = startFilter(
    "process.stdout.write('ready\\n'); process.on('SIGTERM', () => { process.stdout.write('got SIGTERM\\n'); process.exit(0); }); setInterval(() => {}, 1000);",
  );
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGTERM");
  // The stand-in server handles the signal and exits 0, so the filter exits 0.
  assert.deepEqual(await result.exit, { code: 0, signal: null });
  assert.match(result.out, /got SIGTERM/);
});

test("a server killed by a signal ends the filter by that signal", async () => {
  const { child, result } = startFilter("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGTERM");
  assert.deepEqual(await result.exit, { code: null, signal: "SIGTERM" });
});

test("a server that cannot start gives exit code 69", async () => {
  const child = spawn(process.execPath, [filter, "/nonexistent/agy-acp-server"]);
  let err = "";
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 69);
  assert.match(err, /cannot start \/nonexistent\/agy-acp-server/);
});

test("no server argument gives exit code 64", async () => {
  const child = spawn(process.execPath, [filter]);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 64);
});

test("a large burst of lines arrives complete and in order", async () => {
  const { child, result } = startFilter(ECHO);
  const big = "x".repeat(64 * 1024);
  const lines = Array.from({ length: 200 }, (_, i) => `${i} ${big}`);
  child.stdin.end(`${lines.join("\n")}\n`);
  assert.equal((await result.exit).code, 3);
  assert.deepEqual(result.out.trimEnd().split("\n"), lines);
});
