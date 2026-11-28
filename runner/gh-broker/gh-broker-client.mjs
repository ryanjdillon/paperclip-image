#!/usr/local/bin/node
// The host-mode side of gh-broker (DIL-1047). A Legacy SSH run without a
// Paperclip GitHub connection uses the runner's own git and gh config
// (Paperclip 2026.1117.0, execution-configuration.ts:178-183), so there is
// no launcher to ask the broker. This command asks it instead:
//
//   gh-broker-client get|store|erase   a git credential helper
//                                      (/etc/gitconfig, https://github.com only)
//   gh-broker-client token             prints the token, for the gh wrapper
//
// GH_BROKER_URL overrides the broker (default http://127.0.0.1:3100). The
// client never prints the token anywhere but stdout, and only in the two
// forms above.
import http from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:3100";
export const CREDENTIALS_PATH = "/runtime-tools/github/credentials";
const TIMEOUT_MS = 12_000;
const MAX_REPLY_BYTES = 256 * 1024;

const warn = (message) => process.stderr.write(`gh-broker-client: ${message}\n`);

/** Asks the broker. Resolves to the token, or rejects with a safe message. */
export function fetchToken(baseUrl = DEFAULT_BROKER_URL) {
  let url;
  try { url = new URL(CREDENTIALS_PATH, baseUrl); } catch { return Promise.reject(new Error("GH_BROKER_URL is not a URL")); }
  if (url.protocol !== "http:") return Promise.reject(new Error("GH_BROKER_URL must be http://"));
  return new Promise((resolve, reject) => {
    // Its own agent: the broker is on loopback, never behind HTTPS_PROXY.
    const req = http.request(url, {
      method: "POST", agent: new http.Agent(), timeout: TIMEOUT_MS,
      headers: { "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) { req.destroy(); reject(new Error("the broker's answer is too long")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new Error(`the broker answered HTTP ${res.statusCode}`)); return; }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(new Error("the broker's answer is not JSON")); return; }
        const token = body?.env?.GH_TOKEN;
        if (body?.status === "available" && typeof token === "string" && /^[\x21-\x7e]+$/.test(token)) { resolve(token); return; }
        const reason = typeof body?.reason === "string" ? body.reason.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300) : "no reason given";
        reject(new Error(`GitHub credentials are unavailable: ${reason}`));
      });
      res.on("error", () => reject(new Error("the broker's answer broke off")));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => reject(new Error(`the broker at ${url.host} cannot be reached (${error.code ?? error.message})`)));
    req.end("{}");
  });
}

/** The attributes of a git credential request (key=value lines). */
export function parseCredentialRequest(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    if (!line) break;
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const action = argv[0];
  const base = env.GH_BROKER_URL || DEFAULT_BROKER_URL;
  if (action === "token") {
    try { process.stdout.write(`${await fetchToken(base)}\n`); return 0; } catch (error) { warn(error.message); return 1; }
  }
  if (action === "store" || action === "erase") { await readStdin(); return 0; }
  if (action !== "get") { warn("usage: gh-broker-client get|store|erase|token"); return 2; }
  const request = parseCredentialRequest(await readStdin());
  // The URL check in git runs before insteadOf rewrites; check again here,
  // so the token never goes to another host.
  if (request.protocol !== "https" || request.host !== "github.com") return 0;
  try {
    const token = await fetchToken(base);
    process.stdout.write(`username=x-access-token\npassword=${token}\n`);
  } catch (error) {
    // git then tries the next helper or fails; a run sees why.
    warn(error.message);
  }
  return 0;
}

// Installed as a symlink in /usr/local/bin; Node runs the real path.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === invoked) {
  main().then((code) => { process.exitCode = code; }, () => { warn("internal error"); process.exitCode = 1; });
}
