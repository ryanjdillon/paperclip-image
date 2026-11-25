// Starts Antigravity's ACP server and removes the HTTP and SSE MCP servers
// from the session requests that the client sends to it (DIL-1006).
//
// Paperclip 2026.1117.0 sends its MCP servers as HTTP servers (the acpx
// engine maps each one to type "http",
// packages/adapter-utils/src/acpx-engine/execute.ts:2007):
// - "Paperclip projects", on each run on an issue
//   (server/src/services/heartbeat/runtime-execution.ts:833-836);
// - "paperclip-assigned", when the agent has tool connections
//   (server/src/services/heartbeat/run-preparation.ts:1215-1220).
// All of them are on the Paperclip server, port 3100, which the runner
// cannot reach (the agent-runner-egress NetworkPolicy). agy does not
// continue without them:
// - agy 1.4.3 accepts only names that match ^[a-zA-Z0-9_-]+$. It rejects
//   "Paperclip projects" in session/new with "Invalid params" (-32602).
// - With a valid name, the first prompt ends at once with "The MCP server
//   ... failed to initialize".
// The agent reaches the Paperclip API with curl through the run's callback
// bridge instead: Paperclip sets PAPERCLIP_API_URL to the bridge in the
// sandbox and PAPERCLIP_API_KEY to the bridge token
// (packages/adapter-utils/src/execution-target.ts:4910-4914 and 4996-4999),
// and tells the agent to use curl (acpx-engine/execute.ts:3085-3100).
//
// Stdio servers stay: they run on the runner itself. Paperclip 2026.1117.0
// sends none.
// The filter writes only the names of the servers that it removes to
// stderr, never their URLs or headers (the headers hold the run's token). It
// sends all other lines unchanged. stdout and stderr of the server go
// directly to the caller.
//
// Usage: node mcp-filter.mjs <server> [argument ...]
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const SESSION_METHODS = new Set([
  "session/new", "session/load", "session/resume", "session/fork",
]);

// The remote transports of the ACP schema. A stdio server has no type.
export const REMOTE_TYPES = new Set(["http", "sse"]);

// Returns the line to send to the server and the names of the servers that
// were removed. A line that is not a session request with remote MCP
// servers stays the same.
export function filterLine(line) {
  const same = { line, removed: [] };
  // A fast path for the many lines that are not session requests. A key
  // written with JSON escapes ("mcpServers") gets past it. acpx writes
  // with JSON.stringify, which never escapes ASCII letters, so this is
  // acceptable.
  if (!line.includes("mcpServers")) return same;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return same;
  }
  const servers = message?.params?.mcpServers;
  if (!SESSION_METHODS.has(message?.method) || !Array.isArray(servers)) return same;
  const isRemote = (server) => REMOTE_TYPES.has(server?.type);
  const removed = servers.filter(isRemote).map((server) => String(server?.name ?? "?"));
  if (removed.length === 0) return same;
  message.params.mcpServers = servers.filter((server) => !isRemote(server));
  // Only a changed request is written again. JSON.stringify keeps the key
  // order and drops the whitespace, which JSON-RPC permits. A number beyond
  // 2^53 would lose precision; ACP ids from acpx are small integers.
  return { line: JSON.stringify(message), removed };
}

export function main([server, ...args]) {
  if (!server) {
    process.stderr.write("usage: mcp-filter.mjs <server> [argument ...]\n");
    process.exit(64);
  }
  const child = spawn(server, args, { stdio: ["pipe", "inherit", "inherit"] });
  child.on("error", (err) => {
    process.stderr.write(`agy-acp: cannot start ${server}: ${err.message}\n`);
    process.exit(69);
  });
  // The server can close its input first. The next write then fails with
  // EPIPE; the exit handler below ends this process.
  child.stdin.on("error", () => {});
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (raw) => {
    const { line, removed } = filterLine(raw);
    if (removed.length > 0) {
      process.stderr.write(
        `agy-acp: removed HTTP and SSE MCP servers that the runner cannot reach: ${JSON.stringify(removed)}\n`,
      );
    }
    // Back-pressure: stop reading while the server's input is full.
    if (!child.stdin.write(`${line}\n`)) {
      input.pause();
      child.stdin.once("drain", () => input.resume());
    }
  });
  input.on("close", () => child.stdin.end());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// Run main only when this file is the entry point. realpath on both sides,
// so that a symlink to the file still counts.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(process.argv.slice(2));
