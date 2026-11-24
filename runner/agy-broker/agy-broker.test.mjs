import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  DUMMY_ACCESS_TOKEN, DUMMY_REFRESH_TOKEN, MAX_BODY_BYTES, createBroker, createTerminatedServer,
  MAX_HEADER_SETS, createTokenSource, dummyCredentials, forwardHeaders, isNetworkError, parseHeaderList, route,
  upstreamUrl, connectDecision, parseEgressProxy, DEFAULT_EGRESS_PROXY,
} from "./agy-broker.mjs";

const form = (fields) => new URLSearchParams(fields);
const bearer = `Bearer ${DUMMY_ACCESS_TOKEN}`;

test("oauth2: only a refresh of the dummy refresh token is answered", () => {
  const ok = route({ host: "oauth2.googleapis.com", method: "POST", path: "/token",
    form: form({ grant_type: "refresh_token", refresh_token: DUMMY_REFRESH_TOKEN }) });
  assert.equal(ok.action, "dummy-token");
  for (const fields of [
    { grant_type: "refresh_token", refresh_token: "someone-elses-token" },
    { grant_type: "authorization_code", code: "x" },
  ]) {
    assert.equal(route({ host: "oauth2.googleapis.com", method: "POST", path: "/token", form: form(fields) }).action, "deny");
  }
  assert.equal(route({ host: "oauth2.googleapis.com", method: "POST", path: "/revoke",
    form: form({ grant_type: "refresh_token", refresh_token: DUMMY_REFRESH_TOKEN }) }).action, "deny");
});

test("ccpa: only v1internal requests with the dummy bearer go upstream", () => {
  for (const host of ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"]) {
    assert.deepEqual(route({ host, method: "POST", path: "/v1internal:streamGenerateContent?alt=sse", authorization: bearer }),
      { action: "forward", url: `https://${host}/v1internal:streamGenerateContent?alt=sse` });
    assert.equal(route({ host, method: "GET", path: "/v1internal/operations/abc", authorization: bearer }).action, "forward");
    assert.equal(route({ host, method: "POST", path: "/v1internal:loadCodeAssist", authorization: "Bearer real-looking" }).action, "deny");
    assert.equal(route({ host, method: "POST", path: "/v1internal:loadCodeAssist" }).action, "deny");
    assert.equal(route({ host, method: "GET", path: "/v1/projects", authorization: bearer }).action, "deny");
  }
});

test("other hosts are never answered on the terminated server", () => {
  assert.equal(route({ host: "storage.googleapis.com", method: "GET", path: "/v1internal:x", authorization: bearer }).action, "deny");
});

test("dummy credentials carry no real token", () => {
  const real = { client_id: "id", client_secret: "public", project_id: "p", refresh_token: "REAL", scopes: ["s"], token_uri: "u", token: "REAL-ACCESS" };
  const dummy = dummyCredentials(real);
  assert.equal(dummy.refresh_token, DUMMY_REFRESH_TOKEN);
  assert.ok(!JSON.stringify(dummy).includes("REAL"));
  assert.deepEqual(Object.keys(dummy).sort(), ["client_id", "client_secret", "project_id", "refresh_token", "scopes", "token_uri"]);
});

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(init.body) });
    const next = responses.shift();
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { impl, calls };
}

test("token source caches, refreshes near expiry, and keeps a rotated token", async () => {
  let clock = 0;
  const { impl, calls } = fakeFetch([
    { status: 200, body: { access_token: "a1", expires_in: 3600 } },
    { status: 200, body: { access_token: "a2", expires_in: 3600, refresh_token: "rotated" } },
    { status: 200, body: { access_token: "a3", expires_in: 3600 } },
  ]);
  const source = createTokenSource({
    readToken: () => ({ client_id: "id", client_secret: "s", refresh_token: "stored" }),
    fetchImpl: impl, now: () => clock,
  });
  assert.equal(await source(), "a1");
  assert.equal(await source(), "a1");
  assert.equal(calls.length, 1);
  clock = 3_500_000;
  assert.equal(await source(), "a2");
  clock = 7_100_000;
  assert.equal(await source(), "a3");
  assert.deepEqual(calls.map((c) => c.body.refresh_token), ["stored", "stored", "rotated"]);
});

test("concurrent callers share one refresh", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { access_token: "a1", expires_in: 3600 } }]);
  const source = createTokenSource({ readToken: () => ({ refresh_token: "r" }), fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await Promise.all([source(), source(), source()]), ["a1", "a1", "a1"]);
  assert.equal(calls.length, 1);
});

test("upstreamUrl keeps a request inside v1internal after normalization", () => {
  const host = "cloudcode-pa.googleapis.com";
  assert.equal(upstreamUrl(host, "/v1internal:streamGenerateContent?alt=sse"),
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  for (const path of [
    "/v1internal/../v1/projects/x", "/v1internal:a/../../v1/x", "/v1internal/%2e%2e/v1/x",
    "/v1internal/%2E%2E/v1/x", "/v1internal%2f..%2fv1", "/v1internal\\..\\v1\\x",
    "//evil.example/v1internal:x", "https://evil.example/v1internal:x", "v1internal:x", "/v1internalx",
    "/v1internal/%252e%252e/v1/x", "/v1internal%252f..%252fv1", "/v1internal:x?q=%25",
  ]) assert.equal(upstreamUrl(host, path), null, path);
  assert.equal(upstreamUrl("storage.googleapis.com", "/v1internal:x"), null);
});

const REAL_ACCESS = "REAL-ACCESS-TOKEN-must-not-leak";

function startTerminated(host, upstream, options = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  };
  const server = createTerminatedServer({
    accessToken: async () => REAL_ACCESS, fetchImpl, logger: (...parts) => logs.push(parts.join(" ")), ...options,
  });
  server.on("connection", (socket) => { socket.agyHost = host; });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, logs, port: server.address().port })));
}

const until = async (predicate, ms = 2000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function send(port, { method = "POST", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("terminated server: traversal never reaches fetch", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"));
  try {
    for (const path of ["/v1internal/../v1/projects/x", "/v1internal/%2e%2e/v1/x", "/v1internal\\..\\v1"]) {
      const r = await send(port, { path, headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } });
      assert.equal(r.status, 403, path);
    }
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test("terminated server: forwards with the real token and leaks it nowhere", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com",
    () => new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const r = await send(port, { path: "/v1internal:streamGenerateContent?alt=sse", body: "{}",
      headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}`, "proxy-authorization": "Basic x", "content-type": "application/json" } });
    assert.equal(r.status, 200);
    assert.equal(r.body, "data: ok\n\n");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${REAL_ACCESS}`);
    assert.equal(calls[0].init.headers["proxy-authorization"], undefined);
    assert.equal(calls[0].init.redirect, "manual");
    assert.ok(!JSON.stringify(r).includes(REAL_ACCESS));
  } finally { server.close(); }
});

test("terminated server: a redirect goes back to agy, not followed", async () => {
  const { server, port } = await startTerminated("cloudcode-pa.googleapis.com",
    () => new Response(null, { status: 302, headers: { location: "/v1/projects/x" } }));
  try {
    const r = await send(port, { path: "/v1internal:x", body: "{}", headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/v1/projects/x");
  } finally { server.close(); }
});

test("terminated server: an oversized Content-Length gets 413 and never reaches fetch", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"));
  try {
    const r = await send(port, { path: "/v1internal:x", body: Buffer.alloc(MAX_BODY_BYTES + 1),
      headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } });
    assert.equal(r.status, 413);
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test("terminated server: an oversized chunked body gets 413 and never reaches fetch", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1internal:x",
        headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}`, "transfer-encoding": "chunked" } },
      (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i <= MAX_BODY_BYTES / chunk.length; i++) req.write(chunk);
    });
    assert.equal(status, 413);
    assert.equal(calls.length, 0);
  } finally { server.closeAllConnections(); server.close(); }
});

test("terminated server: a client disconnect aborts the upstream call, without an error log", async () => {
  let upstreamSignal;
  const { server, logs, port } = await startTerminated("cloudcode-pa.googleapis.com", (url, init) => {
    upstreamSignal = init.signal;
    // A stream that sends one event and then waits, as a model stream does.
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1internal:streamGenerateContent",
        headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } }, (res) => {
        res.once("data", () => { req.destroy(); resolve(); });
      });
      req.on("error", () => {});
      req.end("{}");
      setTimeout(() => reject(new Error("no first event")), 2000);
    });
    await until(() => upstreamSignal?.aborted);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!logs.some((line) => line.includes("error:")), logs.join("\n"));
  } finally { server.close(); }
});

test("terminated server: a failure mid-stream resets the client and is logged", async () => {
  const { server, logs, port } = await startTerminated("cloudcode-pa.googleapis.com", () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data: 1\n\n")); },
      pull(c) { return new Promise((resolve) => setTimeout(() => { c.error(new Error("upstream broke")); resolve(); }, 20)); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1internal:streamGenerateContent",
        headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on("data", () => {});
        res.on("end", () => resolve("complete"));
        res.on("aborted", () => resolve("reset"));
        res.on("error", () => resolve("reset"));
      });
      req.on("error", () => resolve("reset"));
      req.end("{}");
    });
    assert.equal(outcome, "reset");
    await until(() => logs.some((line) => line.includes("error: upstream broke")));
  } finally { server.close(); }
});

test("headers: denied names never go upstream; an allowlist keeps only its names", () => {
  const incoming = {
    authorization: "Bearer x", "content-type": "application/json", "user-agent": "agy",
    "x-goog-api-key": "k", "x-http-method-override": "DELETE", "proxy-authorization": "Basic x", host: "h",
    "x-goog-user-project": "other-project",
  };
  const open = forwardHeaders(incoming, null);
  assert.deepEqual(open.headers, { "content-type": "application/json", "user-agent": "agy" });
  assert.deepEqual(open.dropped.sort(), ["x-goog-api-key", "x-goog-user-project", "x-http-method-override"]);
  const listed = forwardHeaders(incoming, parseHeaderList(" Content-Type ,"));
  assert.deepEqual(listed.headers, { "content-type": "application/json" });
  assert.equal(parseHeaderList(""), null);
  assert.equal(parseHeaderList(undefined), null);
});

test("terminated server: header names are logged once per set, never the values", async () => {
  const { server, logs, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"),
    { logHeaderNames: true });
  try {
    for (let i = 0; i < 2; i++) {
      await send(port, { path: "/v1internal:x", body: "{}",
        headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}`, "x-secret-ish": "VALUE-must-not-log" } });
    }
    const named = logs.filter((line) => line.includes("request header names:"));
    assert.equal(named.length, 1);
    assert.match(named[0], /authorization,.*x-secret-ish/);
    assert.ok(!logs.some((line) => line.includes("VALUE-must-not-log") || line.includes(DUMMY_ACCESS_TOKEN)));
  } finally { server.close(); }
});

test("terminated server: oauth2 answers the dummy refresh with the dummy token only", async () => {
  const { server, calls, port } = await startTerminated("oauth2.googleapis.com", () => new Response("x"));
  try {
    const ok = await send(port, { path: "/token", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${DUMMY_REFRESH_TOKEN}` });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).access_token, DUMMY_ACCESS_TOKEN);
    assert.ok(!ok.body.includes(REAL_ACCESS));
    const bad = await send(port, { path: "/token", body: "grant_type=refresh_token&refresh_token=other" });
    assert.equal(bad.status, 403);
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test("broker: CONNECT is refused for ports other than 443", async () => {
  const broker = createBroker({ readToken: () => ({}), tlsOptions: {}, fetchImpl: async () => new Response("x") });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  try {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(broker.address().port, "127.0.0.1", () => s.write("CONNECT cloudcode-pa.googleapis.com:80 HTTP/1.1\r\nHost: x\r\n\r\n"));
      let data = "";
      s.on("data", (c) => { data += c; });
      s.on("end", () => resolve(data));
      s.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
  } finally { await broker.shutdown(); }
});

test("terminated server: header-name logging stops after the cap, with one line that says so", async () => {
  const { server, logs, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"),
    { logHeaderNames: true });
  try {
    for (let i = 0; i < MAX_HEADER_SETS + 5; i++) {
      await send(port, { path: "/v1internal:x", body: "{}",
        headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}`, [`x-n${i}`]: "1" } });
    }
    const sets = logs.filter((line) => /request header names: \S*authorization/.test(line));
    assert.equal(sets.length, MAX_HEADER_SETS);
    assert.equal(logs.filter((line) => line.includes("no more are logged")).length, 1);
  } finally { server.close(); }
});

test("terminated server: bodies above the shared buffer budget get 503, and the budget comes back", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"),
    { bufferBudget: 1024 });
  try {
    const headers = { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` };
    const over = await send(port, { path: "/v1internal:x", body: Buffer.alloc(2048), headers });
    assert.equal(over.status, 503);
    assert.equal(calls.length, 0);
    assert.equal(server.bufferedBytes(), 0);
    for (let i = 0; i < 3; i++) {
      const ok = await send(port, { path: "/v1internal:x", body: Buffer.alloc(1000), headers });
      assert.equal(ok.status, 200);
    }
    assert.equal(server.bufferedBytes(), 0);
  } finally { server.close(); }
});

test("isNetworkError: network and upstream faults pass; programming errors do not", () => {
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const fetchFailed = new TypeError("fetch failed", { cause: reset });
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  for (const error of [reset, fetchFailed, abort, new Error("refresh failed: HTTP 400")]) {
    assert.ok(isNetworkError(error), error.message);
  }
  for (const error of [new TypeError("x is not a function"), new ReferenceError("y"), new RangeError("z"), undefined]) {
    assert.ok(!isNetworkError(error), String(error));
  }
});

test("token source: a missing or bad expires_in counts as one hour", async () => {
  for (const expires of [undefined, "soon", 0, -5]) {
    let clock = 0;
    const { impl, calls } = fakeFetch([
      { status: 200, body: { access_token: "a1", expires_in: expires } },
      { status: 200, body: { access_token: "a2", expires_in: 3600 } },
    ]);
    const source = createTokenSource({ readToken: () => ({ refresh_token: "r" }), fetchImpl: impl, now: () => clock });
    assert.equal(await source(), "a1");
    // Refreshes start 120 s before expiry: 3480 s after the first one.
    clock = 3_479_000;
    assert.equal(await source(), "a1", String(expires));
    clock = 3_481_000;
    assert.equal(await source(), "a2", String(expires));
    assert.equal(calls.length, 2);
  }
});

test("a failed refresh is reported without a token", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  const source = createTokenSource({ readToken: () => ({ refresh_token: "r" }), fetchImpl: impl, now: () => 0 });
  await assert.rejects(source(), /refresh failed: HTTP 400 invalid_grant/);
});

// DIL-993: agy's child processes (an agent's git or curl) use the broker as
// their proxy. Only the three Google hosts stay in the broker; every other
// host goes through agent-egress, or gets 403 without it.

const EGRESS = { host: "127.0.0.1", port: 1 };

test("connectDecision: the Google hosts are terminated, every other host is chained", () => {
  for (const host of ["oauth2.googleapis.com", "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"]) {
    assert.deepEqual(connectDecision(`${host}:443`, EGRESS), { action: "terminate", host });
    assert.deepEqual(connectDecision(`${host.toUpperCase()}:443`, EGRESS), { action: "terminate", host });
  }
  for (const host of ["github.com", "ssh.github.com", "example.com", "storage.googleapis.com", "oauth2.googleapis.com.evil.test"]) {
    assert.deepEqual(connectDecision(`${host}:443`, EGRESS), { action: "chain", host });
  }
  // A trailing dot is refused: the name is neither terminated nor chained.
  assert.equal(connectDecision("oauth2.googleapis.com.:443", EGRESS).action, "refuse");
});

test("connectDecision: without an egress proxy, other hosts are refused", () => {
  assert.equal(connectDecision("cloudcode-pa.googleapis.com:443", null).action, "terminate");
  const refused = connectDecision("github.com:443", null);
  assert.equal(refused.action, "refuse");
  assert.match(refused.reason, /github\.com is not one of agy's Google hosts/);
});

test("connectDecision: other ports and malformed authorities are refused", () => {
  for (const authority of [
    "github.com:80", "github.com:22", "cloudcode-pa.googleapis.com:80", "github.com", "github.com:", ":443", "",
    "[::1]:443", "user@github.com:443", "git hub.com:443", "github.com\r\nx: y:443", "-github.com:443",
    "github..com:443", "github.com:0443", undefined,
  ]) {
    assert.equal(connectDecision(authority, EGRESS).action, "refuse", String(authority));
  }
});

test("parseEgressProxy: default, empty and invalid values", () => {
  assert.deepEqual(parseEgressProxy(undefined), { host: "agent-egress.paperclip-agents.svc.cluster.local", port: 3128 });
  assert.equal(DEFAULT_EGRESS_PROXY, "http://agent-egress.paperclip-agents.svc.cluster.local:3128");
  assert.equal(parseEgressProxy(""), null);
  assert.deepEqual(parseEgressProxy("http://10.0.0.1:3128/"), { host: "10.0.0.1", port: 3128 });
  for (const bad of ["agent-egress:3128", "https://agent-egress:3128", "http://agent-egress", "http://u:p@agent-egress:3128",
    "http://agent-egress:3128/x", "http://agent-egress:3128?a=b", "not a url"]) {
    assert.throws(() => parseEgressProxy(bad), /AGY_BROKER_EGRESS_PROXY/, bad);
  }
});

/** A stand-in for agent-egress: it allows the hosts in `allow` and echoes the tunnel. */
async function fakeEgress({ allow = [], reply } = {}) {
  const requests = [];
  const server = net.createServer((s) => {
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      s.off("data", onData);
      const line = head.slice(0, head.indexOf("\r\n"));
      requests.push(line);
      if (reply) { s.end(reply); return; }
      const host = line.split(" ")[1];
      if (!allow.includes(host)) { s.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"); return; }
      s.write("HTTP/1.1 200 OK\r\n\r\n");
      const rest = head.slice(end + 4);
      if (rest) s.write(`echo:${rest}`);
      s.on("data", (c) => s.write(`echo:${c}`));
    };
    s.on("data", onData);
    s.on("error", () => s.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, proxy: { host: "127.0.0.1", port: server.address().port } };
}

/** Sends a CONNECT to the broker; resolves with the reply head and a function for the tunnel. */
function connectThrough(port, authority, { payload } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let data = "";
    let sent = false;
    s.on("data", (c) => {
      data += c;
      if (data.includes("\r\n\r\n") && payload && !sent && data.startsWith("HTTP/1.1 200")) { sent = true; s.write(payload); }
      if (payload && data.includes(`echo:${payload}`)) { s.destroy(); resolve(data); }
    });
    s.on("end", () => resolve(data));
    s.on("close", () => resolve(data));
    s.on("error", reject);
  });
}

async function startBroker(options) {
  const lines = [];
  const broker = createBroker({ readToken: () => ({}), tlsOptions: {}, fetchImpl: async () => new Response("x"),
    logger: (...parts) => lines.push(parts.join(" ")), ...options });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  return { broker, lines, port: broker.address().port };
}

test("broker: another host on 443 is chained through the egress proxy", async () => {
  const egress = await fakeEgress({ allow: ["github.com:443"] });
  const { broker, lines, port } = await startBroker({ egressProxy: egress.proxy });
  try {
    const data = await connectThrough(port, "github.com:443", { payload: "ping" });
    assert.match(data, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    assert.ok(data.includes("echo:ping"));
    assert.deepEqual(egress.requests, ["CONNECT github.com:443 HTTP/1.1"]);
    assert.ok(lines.some((l) => l === "CONNECT github.com chain"));
  } finally { await broker.shutdown(); egress.server.close(); }
});

test("broker: a host that agent-egress refuses gets 403 with a reason", async () => {
  const egress = await fakeEgress({ allow: [] });
  const { broker, port } = await startBroker({ egressProxy: egress.proxy });
  try {
    const data = await connectThrough(port, "exfil.example:443");
    assert.match(data, /^HTTP\/1\.1 403 Forbidden/);
    assert.match(data, /agent-egress refused the host for exfil\.example:443/);
    assert.deepEqual(egress.requests, ["CONNECT exfil.example:443 HTTP/1.1"]);
  } finally { await broker.shutdown(); egress.server.close(); }
});

test("broker: the Google hosts never go to the egress proxy", async () => {
  const egress = await fakeEgress({ allow: ["oauth2.googleapis.com:443"] });
  const { broker, port } = await startBroker({ egressProxy: egress.proxy });
  try {
    const s = net.connect(port, "127.0.0.1", () => s.write("CONNECT oauth2.googleapis.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"));
    const data = await new Promise((resolve, reject) => {
      let d = "";
      s.on("data", (c) => { d += c; if (d.includes("\r\n\r\n")) { s.destroy(); resolve(d); } });
      s.on("error", reject);
    });
    assert.match(data, /^HTTP\/1\.1 200 Connection Established/);
    assert.deepEqual(egress.requests, []);
  } finally { await broker.shutdown(); egress.server.close(); }
});

test("broker: without an egress proxy, another host gets 403 and no connection", async () => {
  const { broker, lines, port } = await startBroker({ egressProxy: null });
  try {
    const data = await connectThrough(port, "github.com:443");
    assert.match(data, /^HTTP\/1\.1 403 Forbidden/);
    assert.match(data, /github\.com is not one of agy's Google hosts/);
    assert.ok(lines.some((l) => l.startsWith("CONNECT github.com refuse")));
  } finally { await broker.shutdown(); }
});

test("broker: an unreachable egress proxy gives 502, a silent one 504", async () => {
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const silent = net.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const a = await startBroker({ egressProxy: { host: "127.0.0.1", port: deadPort } });
  const b = await startBroker({ egressProxy: { host: "127.0.0.1", port: silent.address().port }, egressHandshakeMs: 200 });
  try {
    assert.match(await connectThrough(a.port, "github.com:443"), /^HTTP\/1\.1 502 Bad Gateway[\s\S]*not reachable/);
    assert.match(await connectThrough(b.port, "github.com:443"), /^HTTP\/1\.1 504 Gateway Timeout[\s\S]*did not answer/);
  } finally {
    await a.broker.shutdown(); await b.broker.shutdown();
    silent.close();
  }
});

test("broker: an egress reply other than 200 or 403 gives 502", async () => {
  const egress = await fakeEgress({ reply: "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n" });
  const { broker, port } = await startBroker({ egressProxy: egress.proxy });
  try {
    assert.match(await connectThrough(port, "github.com:443"), /^HTTP\/1\.1 502 Bad Gateway[\s\S]*answered 503/);
  } finally { await broker.shutdown(); egress.server.close(); }
});

test("broker: a plain HTTP proxy request gets 403", async () => {
  const { broker, port } = await startBroker({ egressProxy: EGRESS });
  try {
    const reply = await new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
      let d = "";
      s.on("data", (c) => { d += c; });
      s.on("end", () => resolve(d));
      s.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.match(reply, /use CONNECT/);
  } finally { await broker.shutdown(); }
});
