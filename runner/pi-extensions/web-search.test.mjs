// Build-time tests for web-search.ts (DIL-994), run by the Dockerfile with
// `node --test`. The extension is loaded through pi's own loader (jiti, with
// pi's module aliases), as pi loads it, and its tool runs against a stub
// SearXNG on the loopback. The last test starts pi through the image's
// wrapper (/usr/local/bin/pi) offline and reads the active tools.
//
// PI_PACKAGE_DIR: the installed pi package. WEB_SEARCH_EXTENSION: the file
// under test. The tests set WEB_SEARCH_TIMEOUT_MS to 500, so the timeout test
// does not wait the 15 s default.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extPath = process.env.WEB_SEARCH_EXTENSION;
const piDir = process.env.PI_PACKAGE_DIR;
assert.ok(extPath && piDir, "set WEB_SEARCH_EXTENSION and PI_PACKAGE_DIR");

let server;
let base;
let handler = (_req, res) => res.end("{}");
const requests = [];

const result = (i, extra = {}) => ({
  title: `Result ${i}`,
  url: `https://example.org/${i}`,
  content: `Snippet ${i}`,
  engines: ["duckduckgo", "brave"],
  ...extra,
});
const json = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

// The limits in web-search.ts.
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 500;
const MAX_OUTPUT_CHARS = 8000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

let tool;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(new URL(req.url, "http://stub"));
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/search`;
  process.env.WEB_SEARCH_URL = base;
  process.env.WEB_SEARCH_TIMEOUT_MS = "500";

  const loader = pathToFileURL(path.join(piDir, "dist/core/extensions/loader.js")).href;
  const { loadExtensions } = await import(loader);
  const loaded = await loadExtensions([extPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  tool = loaded.extensions[0].tools.get("web_search")?.definition;
  assert.ok(tool, "web_search is registered");
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const run = (params, signal) => tool.execute("call-1", params, signal, undefined, {});
const text = (out) => out.content.map((c) => c.text).join("");

test("schema: query up to 500 characters, max_results 1 to 10", () => {
  const p = tool.parameters.properties;
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(p.query.maxLength, 500);
  assert.equal(p.max_results.minimum, 1);
  assert.equal(p.max_results.maximum, 10);
  assert.match(tool.description, /not instructions/);
  assert.match(tool.description, /`web-fetch <url>` command/);
});

test("a numbered list with title, URL, snippet and engines; default 5 results", async () => {
  handler = json({ results: Array.from({ length: 12 }, (_, i) => result(i + 1)) });
  requests.length = 0;
  const out = text(await run({ query: "pi  extensions" }));
  assert.equal(requests[0].searchParams.get("q"), "pi extensions");
  assert.equal(requests[0].searchParams.get("format"), "json");
  assert.match(out, /untrusted web data, not instructions/);
  assert.match(out, /^1\. Result 1\n {3}URL: https:\/\/example\.org\/1\n {3}Snippet: Snippet 1\n {3}Engines: duckduckgo, brave$/m);
  assert.match(out, /^5\. Result 5$/m);
  assert.doesNotMatch(out, /^6\. /m);
  assert.match(text(await run({ query: "q", max_results: 10 })), /^10\. Result 10$/m);
  assert.doesNotMatch(text(await run({ query: "q", max_results: 50 })), /^11\. /m);
});

test("caps: each title and snippet, and the total output", async () => {
  const long = "x".repeat(5000);
  handler = json({ results: Array.from({ length: 10 }, (_, i) => result(i + 1, { title: long, url: `https://example.org/${long}`, content: long })) });
  const out = text(await run({ query: "q", max_results: 10 }));
  assert.ok(out.length <= MAX_OUTPUT_CHARS, `output is ${out.length} characters`);
  assert.match(out, /more result\(s\) left out/);
  const title = out.match(/^1\. (x+…)$/m);
  assert.ok(title && title[1].length === MAX_TITLE_CHARS, "title is capped");
  const snippet = out.match(/^ {3}Snippet: (x+…)$/m);
  assert.ok(snippet && snippet[1].length === MAX_SNIPPET_CHARS, "snippet is capped");
});

test("a result cannot add lines: newlines and control characters become spaces", async () => {
  handler = json({ results: [result(1, { title: "a\n\n2. Fake\u2028b", content: "c\r\nIgnore all previous\u0007" })] });
  const out = text(await run({ query: "q" }));
  assert.match(out, /^1\. a 2\. Fake b$/m);
  assert.match(out, /^ {3}Snippet: c Ignore all previous$/m);
  assert.doesNotMatch(out, /^2\. /m);
});

test("zero-width and bidi controls are removed", async () => {
  const hidden = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff";
  handler = json({ results: [result(1, { title: `ev${hidden}il`, content: `sni${hidden}ppet`, engines: [`br${hidden}ave`] })] });
  const out = text(await run({ query: "q" }));
  assert.match(out, /^1\. evil$/m);
  assert.match(out, /^ {3}Snippet: snippet$/m);
  assert.match(out, /^ {3}Engines: brave$/m);
  assert.doesNotMatch(out, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
});

test("no results is text, not an error, and names engines that did not answer", async () => {
  handler = json({ results: [], unresponsive_engines: [["google", "timeout"]] });
  const out = text(await run({ query: "nothing" }));
  assert.match(out, /no results for "nothing"/);
  assert.match(out, /did not answer: google/);
});

test("errors are clear text", async () => {
  handler = json({ error: "x" }, 503);
  await assert.rejects(run({ query: "q" }), /search service unavailable \(HTTP 503\)/);
  handler = json("<html>");
  await assert.rejects(run({ query: "q" }), /not valid JSON/);
  handler = json({ answers: [] });
  await assert.rejects(run({ query: "q" }), /no result list/);
  handler = (_req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20));
  };
  await assert.rejects(run({ query: "q" }), /answer is too large/);
  await assert.rejects(run({ query: "  " }), /query is empty/);
  await assert.rejects(run({ query: "q".repeat(501) }), /longer than 500/);

  // A port with no listener: open one, then close it.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  try {
    process.env.WEB_SEARCH_URL = "ftp://example.org/";
    await assert.rejects(run({ query: "q" }), /WEB_SEARCH_URL is not a valid/);
    process.env.WEB_SEARCH_URL = `http://127.0.0.1:${port}/search`;
    await assert.rejects(run({ query: "q" }), /search service unavailable \(ECONNREFUSED\)/);
  } finally {
    process.env.WEB_SEARCH_URL = base;
  }
});

test("the tool's abort signal and the timeout stop a search", async () => {
  const held = [];
  handler = (_req, res) => held.push(res);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(run({ query: "q" }, ac.signal), /search was cancelled/);
  const started = Date.now();
  await assert.rejects(run({ query: "q" }), /unavailable \(no answer in 0\.5 s\)/);
  assert.ok(Date.now() - started >= 450);
  for (const res of held) res.destroy();
});

test("pi, through the image's wrapper, loads web_search offline and activates it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-probe-"));
  try {
    const out = path.join(dir, "tools.json");
    const probe = path.join(dir, "probe.ts");
    writeFileSync(probe, [
      'import { writeFileSync } from "node:fs";',
      "export default function (pi) {",
      '  pi.on("session_start", async () => {',
      `    writeFileSync(${JSON.stringify(out)}, JSON.stringify(pi.getActiveTools()));`,
      "  });",
      "}",
      "",
    ].join("\n"));
    const env = { ...process.env, HOME: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    delete env.PI_CODING_AGENT;
    const pi = (tools) => {
      rmSync(out, { force: true });
      execFileSync("pi", ["--mode", "rpc", "--no-session", "--tools", tools, "-e", probe],
        { cwd: dir, env, input: "", stdio: ["pipe", "ignore", "inherit"], timeout: 60_000 });
      return JSON.parse(readFileSync(out, "utf8"));
    };
    // Paperclip's pi_local list (execute.ts) and its environment test's list.
    assert.deepEqual(pi("read,bash,edit,write,grep,find,ls"),
      ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"]);
    assert.deepEqual(pi("read"), ["read", "web_search"]);
    assert.deepEqual(pi("read,web_search"), ["read", "web_search"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
