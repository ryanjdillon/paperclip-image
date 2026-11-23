import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import {
  DUMMY_ACCESS_TOKEN, DUMMY_REFRESH_TOKEN, MAX_BODY_BYTES, createBroker, createTerminatedServer,
  createTokenSource, dummyCredentials, route, upstreamUrl,
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
  ]) assert.equal(upstreamUrl(host, path), null, path);
  assert.equal(upstreamUrl("storage.googleapis.com", "/v1internal:x"), null);
});

const REAL_ACCESS = "REAL-ACCESS-TOKEN-must-not-leak";

function startTerminated(host, upstream) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  };
  const server = createTerminatedServer({ accessToken: async () => REAL_ACCESS, fetchImpl });
  server.on("connection", (socket) => { socket.agyHost = host; });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port })));
}

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

test("terminated server: oversized bodies get 413 and never reach fetch", async () => {
  const { server, calls, port } = await startTerminated("cloudcode-pa.googleapis.com", () => new Response("x"));
  try {
    const r = await send(port, { path: "/v1internal:x", body: Buffer.alloc(MAX_BODY_BYTES + 1),
      headers: { authorization: `Bearer ${DUMMY_ACCESS_TOKEN}` } }).catch((e) => ({ status: "reset", e }));
    assert.ok(r.status === 413 || r.status === "reset", String(r.status));
    assert.equal(calls.length, 0);
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

test("a failed refresh is reported without a token", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  const source = createTokenSource({ readToken: () => ({ refresh_token: "r" }), fetchImpl: impl, now: () => 0 });
  await assert.rejects(source(), /refresh failed: HTTP 400 invalid_grant/);
});
