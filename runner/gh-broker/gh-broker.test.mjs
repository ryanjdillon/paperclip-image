import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AUTHOR_WAIT_MS, BrokerError, CREDENTIALS_PATH, FAILURE_HOLD_MS, GITHUB_API, MAX_BODY_BYTES, PERMISSIONS,
  REFRESH_MARGIN_MS, appJwt, createBroker, createIdentitySource, createTokenSource, credentialEnvironment,
  listenWithRetry, loggablePath, parseRepositories, readAppConfig, writeAuthorFile,
} from "./gh-broker.mjs";
import { parseCredentialRequest } from "./gh-broker-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, "gh-broker-client.mjs");
const WRAPPER = path.join(here, "gh.sh");

// A key made for this test run only.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const APP = { appId: "1234567", installationId: "7654321", privateKey };
const REPOS = ["skrap", "dillonteknisk-docs"];
// Values that must never reach a log line.
const MINTED = "ghs_MINTED-installation-token-must-not-leak";
const RUN_JWT = "eyJ-run-jwt-must-not-leak";
const CAPABILITY = "capability-token-must-not-leak";
const QUERY_SECRET = "query-secret-must-not-leak";

// Paperclip 2026.1117.0, packages/adapter-utils/src/github-launcher.ts:145:
// the launcher copies only the env keys that match this pattern.
const LAUNCHER_ENV_KEYS = /^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/;

function verifyJwt(jwt) {
  const [header, payload, signature] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")), "JWT signature");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  return JSON.parse(Buffer.from(payload, "base64url"));
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake api.github.com. `mint` can replace the access_tokens answer. */
function fakeGitHub({ clock = () => Date.now(), mint, ttlMs = 3_600_000 } = {}) {
  const calls = [];
  let count = 0;
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const auth = init.headers?.authorization ?? "";
    if (url === `${GITHUB_API}/app/installations/${APP.installationId}/access_tokens`) {
      assert.equal(init.method, "POST");
      assert.match(auth, /^Bearer /);
      const claims = verifyJwt(auth.slice(7));
      assert.equal(claims.iss, APP.appId);
      if (mint) return mint(JSON.parse(init.body), count++);
      count++;
      const body = JSON.parse(init.body);
      return json(201, {
        token: `${MINTED}-${count}`, expires_at: new Date(clock() + ttlMs).toISOString(),
        permissions: body.permissions, repositories: body.repositories.map((name) => ({ name })),
      });
    }
    if (url === `${GITHUB_API}/app`) { verifyJwt(auth.slice(7)); return json(200, { slug: "winston-test" }); }
    if (url === `${GITHUB_API}/users/winston-test%5Bbot%5D`) {
      assert.match(auth, /^token ghs_/);
      return json(200, { id: 4242, login: "winston-test[bot]" });
    }
    return json(404, { message: "Not Found" });
  };
  return { impl, calls };
}

const mints = (calls) => calls.filter((c) => c.url.endsWith("/access_tokens"));

test("parseRepositories: names only, deduplicated; a bad name is an error", () => {
  assert.deepEqual(parseRepositories(" skrap, dillonteknisk-docs ,skrap,"), REPOS);
  assert.deepEqual(parseRepositories(""), []);
  assert.deepEqual(parseRepositories(undefined), []);
  for (const bad of ["ryanjdillon/skrap", "..", "a b", "*", "x".repeat(101)]) {
    assert.throws(() => parseRepositories(bad), BrokerError, bad);
  }
});

test("appJwt: RS256, signed by the App key, iat 60 s back, at most 10 minutes", () => {
  const now = Date.UTC(2026, 10, 28, 12);
  const claims = verifyJwt(appJwt({ ...APP, now }));
  assert.equal(claims.iss, APP.appId);
  assert.equal(claims.iat, now / 1000 - 60);
  assert.equal(claims.exp - claims.iat, 600);
});

test("readAppConfig: reads the three files; errors never show the content", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-cfg-"));
  try {
    writeFileSync(path.join(dir, "app-id"), "1234567\n");
    writeFileSync(path.join(dir, "installation-id"), " 7654321 ");
    writeFileSync(path.join(dir, "private-key"), PRIVATE_PEM);
    const config = readAppConfig(dir);
    assert.equal(config.appId, "1234567");
    assert.equal(config.installationId, "7654321");
    assert.equal(config.privateKey.asymmetricKeyType, "rsa");
    writeFileSync(path.join(dir, "private-key"), "not-a-key-SECRETVALUE");
    assert.throws(() => readAppConfig(dir), (e) => e instanceof BrokerError && !e.message.includes("SECRETVALUE"));
    writeFileSync(path.join(dir, "app-id"), "12ab-SECRETVALUE");
    assert.throws(() => readAppConfig(dir), (e) => e instanceof BrokerError && !e.message.includes("SECRETVALUE"));
    rmSync(path.join(dir, "installation-id"));
    assert.throws(() => readAppConfig(dir), /cannot read installation-id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("token source: asks for the listed repositories and the three permissions only", async () => {
  const { impl, calls } = fakeGitHub();
  const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, logger: () => {} });
  const minted = await token();
  assert.equal(minted.token, `${MINTED}-1`);
  const [call] = mints(calls);
  assert.deepEqual(JSON.parse(call.init.body), {
    repositories: REPOS, permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  });
  assert.deepEqual(PERMISSIONS, { contents: "write", pull_requests: "write", metadata: "read" });
  assert.equal(call.init.headers["x-github-api-version"], "2022-11-28");
  assert.equal(call.init.redirect, "error");
});

test("token source: caches until 5 minutes before expiry, then mints again", async () => {
  let clock = Date.UTC(2026, 10, 28, 12);
  const { impl, calls } = fakeGitHub({ clock: () => clock });
  const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, now: () => clock, logger: () => {} });
  assert.equal((await token()).token, `${MINTED}-1`);
  clock += 3_600_000 - REFRESH_MARGIN_MS - 1000;
  assert.equal((await token()).token, `${MINTED}-1`);
  assert.equal(mints(calls).length, 1);
  clock += 2000;
  assert.equal((await token()).token, `${MINTED}-2`);
  assert.equal(mints(calls).length, 2);
});

test("token source: concurrent callers share one mint", async () => {
  const { impl, calls } = fakeGitHub();
  const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, logger: () => {} });
  const all = await Promise.all([token(), token(), token(), token()]);
  assert.deepEqual(new Set(all.map((t) => t.token)), new Set([`${MINTED}-1`]));
  assert.equal(mints(calls).length, 1);
});

test("token source: a failed mint is held briefly, then tried again", async () => {
  let clock = 1_000_000;
  const { impl, calls } = fakeGitHub({
    clock: () => clock,
    mint: (body, n) => n === 0 ? json(401, { message: "A JSON web token could not be decoded" })
      : json(201, { token: MINTED, expires_at: new Date(clock + 3_600_000).toISOString(), repositories: [{ name: "skrap" }] }),
  });
  const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, now: () => clock, logger: () => {} });
  await assert.rejects(token(), /HTTP 401 \(A JSON web token could not be decoded\)/);
  await assert.rejects(token(), /HTTP 401/);
  assert.equal(mints(calls).length, 1);
  clock += FAILURE_HOLD_MS + 1;
  assert.equal((await token()).token, MINTED);
});

test("token source: refuses a token for other repositories or more permissions", async () => {
  for (const extra of [
    { repositories: [{ name: "skrap" }, { name: "secret-repo" }] },
    { permissions: { contents: "write", administration: "write" } },
    { permissions: { metadata: "write" } },
    { repositories: undefined },
    { repositories: [] },
  ]) {
    const { impl } = fakeGitHub({
      mint: () => json(201, { token: MINTED, expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories: [{ name: "skrap" }], ...extra }),
    });
    const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, logger: () => {} });
    await assert.rejects(token(), (e) => e instanceof BrokerError && !e.message.includes(MINTED), JSON.stringify(extra));
  }
});

test("token source: no repositories means no mint", async () => {
  const { impl, calls } = fakeGitHub();
  const token = createTokenSource({ readConfig: () => APP, repositories: [], fetchImpl: impl, logger: () => {} });
  await assert.rejects(token(), /no repositories/);
  assert.equal(calls.length, 0);
});

test("identity: configured values win; else the App's bot user, looked up once", async () => {
  const fixed = createIdentitySource({ name: "Bot", email: "bot@example.test", readConfig: () => APP, token: async () => ({}), fetchImpl: () => assert.fail("no lookup"), logger: () => {} });
  assert.deepEqual(await fixed(), { name: "Bot", email: "bot@example.test" });
  const { impl, calls } = fakeGitHub();
  const token = createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, logger: () => {} });
  const seen = [];
  const author = createIdentitySource({ readConfig: () => APP, token, fetchImpl: impl, logger: () => {}, onIdentity: (i) => seen.push(i) });
  const expected = { name: "winston-test[bot]", email: "4242+winston-test[bot]@users.noreply.github.com" };
  assert.deepEqual(await author(), expected);
  assert.deepEqual(await author(), expected);
  assert.equal(calls.filter((c) => c.url === `${GITHUB_API}/app`).length, 1);
  assert.deepEqual(seen, [expected]);
});

test("identity: a slow lookup does not hold a request past its wait", async () => {
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve(json(200, { slug: "x" })); });
  const author = createIdentitySource({ readConfig: () => APP, token: async () => ({ token: "t" }), fetchImpl: slow, logger: () => {} });
  const started = Date.now();
  assert.equal(await author({ waitMs: 50 }), null);
  assert.ok(Date.now() - started < 1000);
  release();
});

test("author file: a git config include, with values quoted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-author-"));
  try {
    const file = path.join(dir, "sub", "author.gitconfig");
    writeAuthorFile(file, { name: 'we"ird\\na\nme[bot]', email: "1+x[bot]@users.noreply.github.com" });
    const text = readFileSync(file, "utf8");
    assert.match(text, /^\tname = "we\\"ird\\\\name\[bot\]"$/m);
    assert.match(text, /^\temail = "1\+x\[bot\]@users\.noreply\.github\.com"$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("credential environment: every key passes the launcher's filter", () => {
  const value = "TKN-value-123";
  const env = credentialEnvironment(value, { name: "n[bot]", email: "1+n[bot]@users.noreply.github.com" });
  for (const key of Object.keys(env)) assert.match(key, LAUNCHER_ENV_KEYS, key);
  assert.equal(env.GH_TOKEN, value);
  assert.equal(env.GITHUB_TOKEN, value);
  assert.equal(env.PAPERCLIP_GIT_TOKEN, value);
  const count = Number(env.GIT_CONFIG_COUNT);
  const entries = Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(entries[0], ["credential.helper", ""]);
  assert.ok(entries.some(([k]) => k === "credential.https://github.com.helper"));
  assert.ok(entries.some(([k, v]) => k === "url.https://github.com/.insteadOf" && v === "git@github.com:"));
  assert.ok(entries.some(([k, v]) => k === "user.name" && v === "n[bot]"));
  // No config value carries the token: the helper reads PAPERCLIP_GIT_TOKEN.
  assert.ok(!entries.some(([, v]) => v.includes(value)));
  const bare = credentialEnvironment(value, null);
  assert.equal(bare.GIT_AUTHOR_NAME, undefined);
});

test("loggablePath drops the query and odd characters", () => {
  assert.equal(loggablePath(`/api/x?token=${QUERY_SECRET}`), "/api/x");
  assert.equal(loggablePath("/a b\u0000c"), "/a?b?c");
});

/** A broker on a random loopback port, with captured logs. */
async function startBroker(options = {}) {
  const logs = [];
  const logger = (...parts) => logs.push(parts.join(" "));
  const { impl, calls } = fakeGitHub();
  const token = options.token ?? createTokenSource({ readConfig: () => APP, repositories: REPOS, fetchImpl: impl, logger });
  const author = options.author ?? createIdentitySource({ readConfig: () => APP, token, fetchImpl: impl, logger });
  const server = createBroker({ token, author, logger, configError: options.configError ?? null });
  await listenWithRetry(server, 0, "127.0.0.1", { logger });
  return { server, logs, calls, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

function send(port, { method = "POST", path: target = CREDENTIALS_PATH, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

// What Paperclip's launcher sends (github-launcher.ts:113-117).
const launcherHeaders = {
  authorization: `Bearer ${RUN_JWT}`, "x-paperclip-github-capability": CAPABILITY, "content-type": "application/json",
};

test("broker: the launcher's POST gets an available answer", async () => {
  const b = await startBroker();
  try {
    const res = await send(b.port, { headers: launcherHeaders, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const body = JSON.parse(res.body);
    assert.equal(body.status, "available");
    assert.equal(body.env.GH_TOKEN, `${MINTED}-1`);
    assert.equal(body.env.GIT_AUTHOR_NAME, "winston-test[bot]");
    for (const key of Object.keys(body.env)) assert.match(key, LAUNCHER_ENV_KEYS);
    // The second call uses the cached token.
    await send(b.port, { headers: launcherHeaders, body: "{}" });
    assert.equal(mints(b.calls).length, 1);
  } finally { b.server.close(); }
});

test("broker: 404 for every other path and method, without reading the body", async () => {
  const b = await startBroker();
  try {
    for (const [method, target] of [
      ["GET", CREDENTIALS_PATH], ["PUT", CREDENTIALS_PATH], ["POST", `${CREDENTIALS_PATH}/`],
      ["POST", `${CREDENTIALS_PATH}?x=1`], ["POST", `/api${CREDENTIALS_PATH}`], ["GET", "/api/companies"],
      ["POST", "/api/mcp/project-tools"], ["POST", "/mcp/runtime-tools"], ["GET", "/"],
      ["GET", "/api/runner/v1/connect/00000000-0000-0000-0000-000000000000"],
    ]) {
      const res = await send(b.port, { method, path: target, headers: launcherHeaders, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 404, `${method} ${target}`);
    }
    assert.equal(b.calls.length, 0, "no call to GitHub");
    assert.equal((await send(b.port, { method: "GET", path: "/healthz" })).status, 200);
  } finally { b.server.close(); }
});

test("broker: refuses browser requests and large bodies", async () => {
  const b = await startBroker();
  try {
    for (const extra of [{ origin: "https://evil.example" }, { cookie: "a=b" }, { "sec-fetch-site": "cross-site" }]) {
      assert.equal((await send(b.port, { headers: { ...launcherHeaders, ...extra }, body: "{}" })).status, 403);
    }
    assert.equal((await send(b.port, { headers: launcherHeaders, body: "x".repeat(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal(mints(b.calls).length, 0);
  } finally { b.server.close(); }
});

test("broker: a GitHub fault or a config fault is an unavailable answer with a reason", async () => {
  const failing = await startBroker({ token: async () => { throw new BrokerError("token mint: GitHub answered HTTP 500"); }, author: async () => null });
  const broken = await startBroker({ configError: new BrokerError("GH_BROKER_REPOSITORIES: bad") });
  const crashing = await startBroker({ token: async () => { throw new TypeError("fetch failed"); }, author: async () => null });
  try {
    for (const [b, reason] of [[failing, /HTTP 500/], [broken, /GH_BROKER_REPOSITORIES/], [crashing, /could not be reached/]]) {
      const res = await send(b.port, { headers: launcherHeaders, body: "{}" });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, "unavailable");
      assert.match(body.reason, reason);
      assert.deepEqual(body.env, {});
    }
  } finally { failing.server.close(); broken.server.close(); crashing.server.close(); }
});

test("broker: no token, header value, query or key in any log line", async () => {
  const b = await startBroker();
  try {
    await send(b.port, { headers: launcherHeaders, body: "{}" });
    await send(b.port, { method: "GET", path: `/api/agents/me?token=${QUERY_SECRET}`, headers: launcherHeaders });
    await send(b.port, { path: "/api/mcp/project-tools", headers: launcherHeaders, body: `{"jwt":"${RUN_JWT}"}` });
    await send(b.port, { headers: { ...launcherHeaders, origin: "x" }, body: "{}" });
    const text = b.logs.join("\n");
    assert.ok(b.logs.some((l) => l.includes("available")), text);
    for (const secret of [MINTED, RUN_JWT, CAPABILITY, QUERY_SECRET, "PRIVATE KEY", "Bearer"]) {
      assert.ok(!text.includes(secret), `log carries ${secret}`);
    }
  } finally { b.server.close(); }
});

test("listenWithRetry: a bad address is logged and tried again, not thrown", async () => {
  const logs = [];
  const server = http.createServer();
  listenWithRetry(server, 0, "192.0.2.1", { retryMs: 20, logger: (m) => logs.push(m) });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(logs.some((l) => l.includes("cannot listen on 192.0.2.1")), logs.join("\n"));
  assert.equal(logs.filter((l) => l.includes("cannot listen")).length, 1);
  server.close();
});

test("listenWithRetry: waits for a taken port instead of exiting", async () => {
  const squatter = http.createServer();
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const port = squatter.address().port;
  const logs = [];
  const server = http.createServer((req, res) => res.end("broker"));
  const listening = listenWithRetry(server, port, "127.0.0.1", { retryMs: 20, logger: (m) => logs.push(m) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(logs.some((l) => l.includes("is taken")));
  await new Promise((resolve) => squatter.close(resolve));
  await listening;
  assert.equal(server.address().port, port);
  server.close();
});

function run(command, args, { env = {}, input = "", cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { PATH: process.env.PATH, HOME: tmpdir(), ...env }, cwd });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(input);
  });
}

const GITHUB_REQUEST = "protocol=https\nhost=github.com\npath=ryanjdillon/skrap.git\n\n";

test("client: answers git's get for https://github.com only", async () => {
  const b = await startBroker();
  try {
    const env = { GH_BROKER_URL: b.url };
    const got = await run(process.execPath, [CLIENT, "get"], { env, input: GITHUB_REQUEST });
    assert.equal(got.code, 0);
    assert.equal(got.stdout, `username=x-access-token\npassword=${MINTED}-1\n`);
    for (const input of ["protocol=http\nhost=github.com\n\n", "protocol=https\nhost=evil.example\n\n", "protocol=https\nhost=github.com.evil.example\n\n"]) {
      const other = await run(process.execPath, [CLIENT, "get"], { env, input });
      assert.equal(other.stdout, "", input);
    }
    for (const action of ["store", "erase"]) {
      const res = await run(process.execPath, [CLIENT, action], { env, input: GITHUB_REQUEST + "password=x\n" });
      assert.deepEqual([res.code, res.stdout], [0, ""]);
    }
    const token = await run(process.execPath, [CLIENT, "token"], { env });
    assert.deepEqual([token.code, token.stdout], [0, `${MINTED}-1\n`]);
    assert.equal((await run(process.execPath, [CLIENT, "bogus"], { env })).code, 2);
  } finally { b.server.close(); }
});

test("client: a broker that is down or has no token gives a reason, not a secret", async () => {
  const down = { GH_BROKER_URL: "http://127.0.0.1:1" };
  const get = await run(process.execPath, [CLIENT, "get"], { env: down, input: GITHUB_REQUEST });
  assert.deepEqual([get.code, get.stdout], [0, ""]);
  assert.match(get.stderr, /cannot be reached/);
  const token = await run(process.execPath, [CLIENT, "token"], { env: down });
  assert.equal(token.code, 1);
  const b = await startBroker({ configError: new BrokerError("no repositories are configured") });
  try {
    const res = await run(process.execPath, [CLIENT, "token"], { env: { GH_BROKER_URL: b.url } });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /unavailable: GitHub broker: no repositories/);
  } finally { b.server.close(); }
});

test("client: runs through a symlink, as installed in /usr/local/bin", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-link-"));
  const b = await startBroker();
  try {
    symlinkSync(CLIENT, path.join(dir, "gh-broker-client"));
    const res = await run(process.execPath, [path.join(dir, "gh-broker-client"), "token"], { env: { GH_BROKER_URL: b.url } });
    assert.deepEqual([res.code, res.stdout], [0, `${MINTED}-1\n`]);
  } finally { b.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("parseCredentialRequest stops at the blank line", () => {
  assert.deepEqual(parseCredentialRequest("protocol=https\nhost=github.com\n\nhost=evil\n"), { protocol: "https", host: "github.com" });
});

/** A shell script that runs the client with this node (no shebang path needed). */
function clientScript(dir) {
  const file = path.join(dir, "client");
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${CLIENT}' "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

test("git: the credential helper gives git the token for github.com", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-git-"));
  const b = await startBroker();
  try {
    const env = { GH_BROKER_URL: b.url, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    // As in the image's /etc/gitconfig: the empty helper first.
    const config = ["-c", "credential.https://github.com.helper=", "-c", `credential.https://github.com.helper=${clientScript(dir)}`];
    const filled = await run("git", [...config, "credential", "fill"], { env, input: GITHUB_REQUEST });
    assert.equal(filled.code, 0, filled.stderr);
    assert.match(filled.stdout, /^username=x-access-token$/m);
    assert.match(filled.stdout, new RegExp(`^password=${MINTED}-1$`, "m"));
    const other = await run("git", [...config, "credential", "fill"], { env, input: "protocol=https\nhost=gitlab.com\n\n" });
    assert.notEqual(other.code, 0, "no credential for another host");
    assert.ok(!other.stdout.includes(MINTED));
  } finally { b.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("gh wrapper: adds a broker token only when the run has none", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-wrapper-"));
  const b = await startBroker();
  try {
    const stub = path.join(dir, "real-gh");
    writeFileSync(stub, '#!/bin/sh\nprintf "token=%s args=" "${GH_TOKEN:-none}"; for a do printf "[%s]" "$a"; done; echo\n');
    chmodSync(stub, 0o755);
    const wrapper = path.join(dir, "gh");
    const source = readFileSync(WRAPPER, "utf8").replace("@GH_REAL@", stub).replace("@GH_BROKER_CLIENT@", clientScript(dir));
    assert.ok(!/@GH_[A-Z_]+@/.test(source), "all placeholders filled");
    writeFileSync(wrapper, source);
    chmodSync(wrapper, 0o755);
    const host = await run(wrapper, ["pr", "create", "--title", "a b"], { env: { GH_BROKER_URL: b.url } });
    assert.equal(host.stdout, `token=${MINTED}-1 args=[pr][create][--title][a b]\n`);
    const managed = await run(wrapper, ["pr", "view"], { env: { GH_BROKER_URL: b.url, GH_TOKEN: "from-launcher" } });
    assert.equal(managed.stdout, "token=from-launcher args=[pr][view]\n");
    const down = await run(wrapper, ["--version"], { env: { GH_BROKER_URL: "http://127.0.0.1:1" } });
    assert.equal(down.stdout, "token=none args=[--version]\n");
    assert.match(down.stderr, /cannot be reached/);
    assert.equal(mints(b.calls).length, 1);
  } finally { b.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// The real launcher from Paperclip (github-launcher.ts, the module that the
// server stages for each managed run). The image build sets
// PAPERCLIP_LAUNCHER_MODULE from the server image of the pinned release.
const launcherModule = process.env.PAPERCLIP_LAUNCHER_MODULE;
test("launcher contract: Paperclip's own git launcher gets the token and author from the broker", { skip: !launcherModule && "PAPERCLIP_LAUNCHER_MODULE is not set" }, async () => {
  const { githubLauncherSource } = await import(pathToFileURL(launcherModule).href);
  const dir = mkdtempSync(path.join(tmpdir(), "gh-broker-launcher-"));
  const b = await startBroker();
  try {
    const launcherDir = path.join(dir, "launchers");
    await new Promise((resolve, reject) => execFile("mkdir", ["-p", launcherDir], (e) => e ? reject(e) : resolve()));
    writeFileSync(path.join(launcherDir, "package.json"), '{"type":"commonjs"}\n');
    writeFileSync(path.join(launcherDir, "git"), githubLauncherSource({ interpreterPath: process.execPath }));
    chmodSync(path.join(launcherDir, "git"), 0o755);
    // As githubBrokerEnvironment and prepareGitHubOperationLaunchers set it.
    const env = {
      PATH: `${launcherDir}:${process.env.PATH}`,
      PAPERCLIP_GITHUB_BROKER_URL: b.url,
      PAPERCLIP_GITHUB_BROKER_TOKEN: CAPABILITY,
      PAPERCLIP_API_KEY: RUN_JWT,
      GH_CONFIG_DIR: path.join(dir, "gh-config"),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    };
    const filled = await run("git", ["credential", "fill"], { env, input: GITHUB_REQUEST });
    assert.equal(filled.code, 0, filled.stderr);
    assert.match(filled.stdout, new RegExp(`^password=${MINTED}-1$`, "m"));
    assert.ok(!filled.stderr.includes("continuing without managed credentials"), filled.stderr);
    const ident = await run("git", ["var", "GIT_AUTHOR_IDENT"], { env });
    assert.match(ident.stdout, /^winston-test\[bot\] <4242\+winston-test\[bot\]@users\.noreply\.github\.com> /);
    // A local command does not ask the broker.
    const before = b.logs.filter((l) => l.includes("available")).length;
    assert.equal((await run("git", ["--version"], { env })).code, 0);
    assert.equal(b.logs.filter((l) => l.includes("available")).length, before);
    const text = b.logs.join("\n");
    for (const secret of [MINTED, RUN_JWT, CAPABILITY]) assert.ok(!text.includes(secret), `log carries ${secret}`);
  } finally { b.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("AUTHOR_WAIT_MS is below the launcher's 10 s request timeout", () => {
  assert.ok(AUTHOR_WAIT_MS < 10_000);
});
