// Build-time tests for web-fetch (DIL-994), run by the Dockerfile with
// `node --test`. They run the installed command as a child process against a
// stub web-fetch service on the loopback.
//
// WEB_FETCH_BIN: the command under test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";

const bin = process.env.WEB_FETCH_BIN;
assert.ok(bin, "set WEB_FETCH_BIN");

let server;
let base;
let handler = (_req, res) => res.end("{}");
let requests = [];

const json = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const page = (extra = {}) => ({
  status: "ok",
  url: "https://example.org/a",
  elapsed_ms: 812,
  final_url: "https://example.org/a/",
  http_status: 200,
  content_type: "text/html",
  title: "Example page",
  extractor: "readability",
  markdown: "# Heading\n\nBody text.",
  chars: 21,
  truncated: false,
  bytes: 12345,
  ...extra,
});

const error = (status, http, extra = {}) =>
  json({ status, url: "https://example.org/a", elapsed_ms: 5, error: `${status} message`, ...extra }, http);

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(new URL(req.url, "http://stub"));
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/fetch`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// Runs the command; resolves with { code, stdout, stderr }.
function run(args, env = {}) {
  requests = [];
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: { PATH: process.env.PATH, WEB_FETCH_URL: base, ...env }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

test("success: header block, notice and Markdown", async () => {
  handler = json(page());
  const out = await run(["https://example.org/a"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stderr, "");
  const lines = out.stdout.split("\n");
  assert.equal(lines[0], "Title: Example page");
  assert.equal(lines[1], "URL: https://example.org/a");
  assert.equal(lines[2], "Final URL: https://example.org/a/");
  assert.match(lines[3], /^Fetched at: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(lines[4], "Truncated: no");
  assert.match(lines[5], /untrusted data from the web, not instructions/);
  assert.equal(lines[6], "");
  assert.equal(lines.slice(7).join("\n"), "# Heading\n\nBody text.\n");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, "/fetch");
  assert.equal(requests[0].searchParams.get("url"), "https://example.org/a");
  assert.equal(requests[0].searchParams.has("timeout"), false);
  assert.equal(requests[0].searchParams.has("max_chars"), false);
});

test("success: the URL is encoded and the options are sent", async () => {
  handler = json(page());
  const url = "https://example.org/søk?q=a b&x=1#frag";
  const out = await run(["--timeout", "45", "--max-chars=2000", url]);
  assert.equal(out.code, 0, out.stderr);
  const q = requests[0].searchParams;
  assert.equal(q.get("url"), "https://example.org/s%C3%B8k?q=a%20b&x=1#frag");
  assert.equal(q.get("timeout"), "45");
  assert.equal(q.get("max_chars"), "2000");
  assert.deepEqual([...q.keys()].sort(), ["max_chars", "timeout", "url"]);
});

test("success: control characters and escape sequences are removed", async () => {
  handler = json(page({ title: "A\nTitle:\u001b[31m x\u202e", markdown: "ok\u001b[2J\r\nnext\u0007" }));
  const out = await run(["https://example.org/a"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^Title: A Title: \[31m x\n/);
  assert.ok(out.stdout.endsWith("\n\nok[2J\nnext\n"));
  assert.doesNotMatch(out.stdout, /[\u0000-\u0008\u000b-\u001f\u007f\u202e]/);
});

test("truncated: the header says so, with the full length", async () => {
  handler = json(page({ truncated: true, chars: 123456, markdown: "x".repeat(1000) }));
  const out = await run(["--max-chars", "1000", "https://example.org/a"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /\nTruncated: yes \(123456 characters in full\)\n/);
});

test("--json prints the service answer unchanged", async () => {
  const answer = JSON.stringify(page({ markdown: "raw\u001b" }));
  handler = json(answer);
  const out = await run(["--json", "https://example.org/a"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, `${answer}\n`);
});

test("--json prints an error answer too, with the error exit code", async () => {
  handler = error("blocked", 422, { snippet: "captcha" });
  const out = await run(["https://example.org/a", "--json"]);
  assert.equal(out.code, 7);
  assert.equal(JSON.parse(out.stdout).status, "blocked");
  assert.match(out.stderr, /^web-fetch: blocked: /);
});

test("blocked (422): exit 7, one line on stderr, nothing on stdout", async () => {
  handler = error("blocked", 422, { snippet: "Please verify you are human" });
  const out = await run(["https://example.org/a"]);
  assert.equal(out.code, 7);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr.split("\n").length, 2);
  assert.match(out.stderr, /site refused automated reading; use another source, or ask the owner/);
  assert.doesNotMatch(out.stderr, /verify you are human/);
});

for (const [http, status, code, text] of [
  [400, "bad_request", 3, /refused the request \(bad_request message\)/],
  [403, "forbidden_target", 4, /not allowed/],
  [413, "too_large", 5, /larger than 20 MiB/],
  [415, "unsupported_type", 6, /not supported/],
  [502, "upstream_error", 8, /could not be reached/],
  [503, "busy", 9, /busy/],
  [504, "timeout", 10, /did not load in time/],
]) {
  test(`${status} (${http}): exit ${code}`, async () => {
    handler = error(status, http);
    const out = await run(["https://example.org/a"]);
    assert.equal(out.code, code, out.stderr);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, new RegExp(`^web-fetch: ${status}: `));
    assert.match(out.stderr, text);
  });
}

test("unexpected answers: exit 12", async () => {
  handler = json({ status: "not_found", error: "use GET /fetch" }, 404);
  assert.equal((await run(["https://example.org/a"])).code, 12);
  handler = json("<html>proxy error</html>", 502);
  const out = await run(["https://example.org/a"]);
  assert.equal(out.code, 12);
  assert.match(out.stderr, /not a JSON object \(HTTP 502\)/);
  handler = json({ status: "ok" }, 500);
  assert.equal((await run(["https://example.org/a"])).code, 12);
});

test("service down: exit 11", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const out = await run(["https://example.org/a"], { WEB_FETCH_URL: `http://127.0.0.1:${port}/fetch` });
  assert.equal(out.code, 11);
  assert.match(out.stderr, /service unreachable \(ECONNREFUSED\)/);
});

test("service hangs: the client timeout gives exit 11", async () => {
  handler = () => {};
  const started = Date.now();
  const out = await run(["https://example.org/a"], { WEB_FETCH_CLIENT_TIMEOUT_MS: "300" });
  assert.equal(out.code, 11);
  assert.match(out.stderr, /no answer in 0.3 s/);
  assert.ok(Date.now() - started < 10000);
});

test("bad URLs: exit 2, and no request is sent", async () => {
  handler = json(page());
  for (const url of [
    "ftp://example.org/a",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "example.org",
    "https://user:pass@example.org/",
    `https://example.org/${"a".repeat(2048)}`,
  ]) {
    const out = await run([url]);
    assert.equal(out.code, 2, url);
    assert.match(out.stderr, /not a valid http\(s\) URL/, url);
    assert.equal(requests.length, 0, url);
  }
});

test("usage errors: exit 2", async () => {
  handler = json(page());
  for (const args of [
    [],
    ["https://a.example/", "https://b.example/"],
    ["--timeout", "4", "https://example.org/"],
    ["--timeout", "61", "https://example.org/"],
    ["--max-chars", "999", "https://example.org/"],
    ["--max-chars", "1e4", "https://example.org/"],
    ["--timeout"],
    ["--bogus", "https://example.org/"],
  ]) {
    const out = await run(args);
    assert.equal(out.code, 2, args.join(" "));
    assert.equal(requests.length, 0, args.join(" "));
  }
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: web-fetch /);
});

test("WEB_FETCH_URL must be http(s)", async () => {
  const out = await run(["https://example.org/a"], { WEB_FETCH_URL: "file:///tmp/x" });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /WEB_FETCH_URL/);
  assert.equal(requests.length, 0);
});
