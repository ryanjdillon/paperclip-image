// Starts Antigravity's ACP server and removes the MCP servers from the
// session requests that the client sends to it (DIL-1006).
//
// Paperclip 2026.1117.0 adds the HTTP MCP server "Paperclip projects" to
// each run on an issue (server/src/services/heartbeat/runtime-execution.ts:835),
// and its tool connections as more HTTP MCP servers. All of them are on the
// Paperclip server, port 3100, which the runner cannot reach (the
// agent-runner-egress NetworkPolicy). agy does not continue without them:
// - agy 1.4.3 accepts only names that match ^[a-zA-Z0-9_-]+$. It rejects
//   "Paperclip projects" in session/new with "Invalid params" (-32602).
// - With a valid name, the first prompt ends at once with "The MCP server
//   ... failed to initialize".
// Paperclip's API stays available to the agent through the run's callback
// bridge, as for heartbeats. The filter writes the names of the servers that
// it removes to stderr, never their URLs or headers (they hold the run's
// token). It sends all other lines unchanged. stdout and stderr of the server
// go directly to the caller.
//
// Usage: node mcp-filter.mjs <server> [argument ...]
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

export const SESSION_METHODS = new Set([
  "session/new", "session/load", "session/resume", "session/fork",
]);

// Returns the line to send to the server and the names of the servers that
// were removed. A line that is not a session request with MCP servers stays
// the same.
export function filterLine(line) {
  const same = { line, removed: [] };
  if (!line.includes("mcpServers")) return same;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return same;
  }
  const servers = message?.params?.mcpServers;
  if (!SESSION_METHODS.has(message?.method) || !Array.isArray(servers) || servers.length === 0) {
    return same;
  }
  const removed = servers.map((server) => String(server?.name ?? "?"));
  message.params.mcpServers = [];
  return { line: JSON.stringify(message), removed };
}

function main([server, ...args]) {
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
      process.stderr.write(`agy-acp: removed MCP servers that the runner cannot reach: ${JSON.stringify(removed)}\n`);
    }
    child.stdin.write(`${line}\n`);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
