import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DUMMY_ACCESS_TOKEN, DUMMY_REFRESH_TOKEN, createTokenSource, dummyCredentials, route,
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
    assert.equal(route({ host, method: "POST", path: "/v1internal:streamGenerateContent?alt=sse", authorization: bearer }).action, "forward");
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

test("a failed refresh is reported without a token", async () => {
  const { impl } = fakeFetch([{ status: 400, body: { error: "invalid_grant" } }]);
  const source = createTokenSource({ readToken: () => ({ refresh_token: "r" }), fetchImpl: impl, now: () => 0 });
  await assert.rejects(source(), /refresh failed: HTTP 400 invalid_grant/);
});
