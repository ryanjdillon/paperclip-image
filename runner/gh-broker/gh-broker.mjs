// GitHub credential broker for the agent runner (DIL-1047). It runs as a
// sidecar in the runner pod, as its own UID, and it is the only container
// that mounts the GitHub App's private key. It mints installation tokens for
// a fixed list of repositories, with contents write, pull_requests write and
// metadata read, and keeps each token until 5 minutes before it expires.
//
// It serves Paperclip's launcher contract (Paperclip 2026.1117.0,
// packages/adapter-utils/src/github-launcher.ts:100-150). The git and gh
// launchers of a managed run POST to
// <PAPERCLIP_GITHUB_BROKER_URL>/runtime-tools/github/credentials. That URL
// is the server's PAPERCLIP_API_URL, paperclip.paperclip.svc.cluster.local
// on 3100. The runner pod maps that name to 127.0.0.1 (hostAliases), so the
// request comes here. The launcher copies GH_TOKEN, GIT_CONFIG_* and the
// author variables from the "env" of an "available" answer.
//
// Host-mode runs (Legacy SSH runs without a Paperclip GitHub connection) use
// the same endpoint through gh-broker-client: the git credential helper in
// /etc/gitconfig and the gh wrapper.
//
// Every other request gets 404. The broker never forwards to the real
// server. Requests to the hijacked name carry a run JWT in Authorization
// and a capability token, so the broker never logs a header value, a query
// string or a body. It does not check those tokens: it has no key to check
// them with. So every process that can reach 127.0.0.1:3100 in the pod can
// get a token (see the README, "GitHub credentials").
import http from "node:http";
import { createPrivateKey, createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CREDENTIALS_PATH = "/runtime-tools/github/credentials";
export const GITHUB_API = "https://api.github.com";
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "paperclip-gh-broker";
// The only permissions a token gets. GitHub refuses a request for more than
// the App has, and a token never gets more than it asks for.
export const PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", metadata: "read" });
// A token is used until this long before it expires.
export const REFRESH_MARGIN_MS = 5 * 60_000;
// A failed mint is not tried again for this long, so that a fault at GitHub
// does not turn every git command into an API call.
export const FAILURE_HOLD_MS = 10_000;
// The launcher sends "{}". Anything much larger is not the launcher.
export const MAX_BODY_BYTES = 64 * 1024;
// Shorter than the launcher's own 10 s timeout, so that the launcher gets
// "unavailable" with a reason and not a transport failure.
export const GITHUB_TIMEOUT_MS = 8_000;
// How long a request for credentials waits for the git author lookup.
export const AUTHOR_WAIT_MS = 1_500;
export const DEFAULT_SECRET_DIR = "/run/secrets/github-app";

// Paperclip's own helper (server/src/services/git-credentials.ts:43-44). It
// answers only `get`, only for https://github.com, and reads the token from
// PAPERCLIP_GIT_TOKEN, so the token never appears in argv or config.
export const GIT_CREDENTIAL_HELPER =
  `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;

const defaultLogger = (...parts) => console.log("[gh-broker]", ...parts);

/** A fault that is safe to show to a run: it holds no secret. */
export class BrokerError extends Error {}

const REPOSITORY_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * The repository names from GH_BROKER_REPOSITORIES (a comma list). Names
 * only, without the owner: the App is installed on one account. An invalid
 * name is an error, so that a typo never widens or empties the list unseen.
 */
export function parseRepositories(text) {
  const names = (text ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  for (const name of names) {
    if (!REPOSITORY_NAME.test(name)) {
      throw new BrokerError(`GH_BROKER_REPOSITORIES: "${name.slice(0, 100)}" is not a repository name (give names without the owner)`);
    }
  }
  return [...new Set(names)];
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/**
 * A GitHub App JWT (RS256). GitHub accepts at most 10 minutes; iat is 60 s in
 * the past for clock drift, as GitHub's docs advise.
 */
export function appJwt({ appId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
}

/**
 * Reads the App's configuration from the Secret's directory: app-id,
 * installation-id and private-key (PEM). Errors name the file, never its
 * content.
 */
export function readAppConfig(dir = DEFAULT_SECRET_DIR, readFile = readFileSync) {
  const read = (name) => {
    try { return readFile(path.join(dir, name), "utf8").trim(); } catch {
      throw new BrokerError(`cannot read ${name} in ${dir}`);
    }
  };
  const appId = read("app-id");
  const installationId = read("installation-id");
  if (!/^\d{1,20}$/.test(appId)) throw new BrokerError("app-id is not a number");
  if (!/^\d{1,20}$/.test(installationId)) throw new BrokerError("installation-id is not a number");
  let privateKey;
  try { privateKey = createPrivateKey(read("private-key")); } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("private-key is not a PEM private key");
  }
  return { appId, installationId, privateKey };
}

const githubHeaders = (authorization) => ({
  accept: "application/vnd.github+json",
  authorization,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
});

/** GitHub's error message, cut short and without control characters. */
async function githubFault(response, what) {
  const body = await response.json().catch(() => ({}));
  const message = typeof body?.message === "string" ? body.message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) : "";
  return new BrokerError(`${what}: GitHub answered HTTP ${response.status}${message ? ` (${message})` : ""}`);
}

/**
 * Mints installation tokens for `repositories`, one mint at a time, and
 * keeps each until REFRESH_MARGIN_MS before it expires.
 */
export function createTokenSource({
  readConfig, repositories, fetchImpl = fetch, now = Date.now, logger = defaultLogger,
}) {
  let cached = null;
  let failure = null;
  let inFlight = null;
  async function mint() {
    if (!repositories.length) throw new BrokerError("no repositories are configured (GH_BROKER_REPOSITORIES)");
    const config = readConfig();
    const response = await fetchImpl(`${GITHUB_API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: { ...githubHeaders(`Bearer ${appJwt({ ...config, now: now() })}`), "content-type": "application/json" },
      body: JSON.stringify({ repositories, permissions: PERMISSIONS }),
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (response.status !== 201) throw await githubFault(response, "token mint");
    const body = await response.json().catch(() => null);
    const expiresAt = Date.parse(body?.expires_at);
    if (typeof body?.token !== "string" || !body.token || !Number.isFinite(expiresAt)) {
      throw new BrokerError("token mint: GitHub's answer has no token or expiry");
    }
    // GitHub limits the token to the requested list. Check it anyway: a
    // token for any other repository is never handed out.
    if (!Array.isArray(body.repositories) || !body.repositories.length) {
      throw new BrokerError("token mint: GitHub's answer does not list the repositories");
    }
    const granted = body.repositories.map((r) => r?.name);
    const extra = granted.filter((name) => !repositories.includes(name));
    if (extra.length) throw new BrokerError(`token mint: GitHub granted repositories outside the list (${extra.length})`);
    const permissions = body.permissions ?? {};
    for (const [name, level] of Object.entries(permissions)) {
      if (!(name in PERMISSIONS) || (PERMISSIONS[name] === "read" && level !== "read")) {
        throw new BrokerError(`token mint: GitHub granted a permission outside the list (${String(name).slice(0, 50)})`);
      }
    }
    logger(`minted a token for ${repositories.length} repositories, expires ${new Date(expiresAt).toISOString()}`);
    return { token: body.token, expiresAt, installationId: config.installationId, appId: config.appId };
  }
  async function refresh() {
    try {
      cached = await mint();
      failure = null;
      return cached;
    } catch (error) {
      failure = { error, until: now() + FAILURE_HOLD_MS };
      throw error;
    }
  }
  return async function token() {
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached;
    if (failure && failure.until > now()) throw failure.error;
    inFlight ??= refresh().finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** A git config value in double quotes: no newline, backslash or quote left raw. */
function gitConfigValue(value) {
  return `"${String(value).replace(/[\x00-\x1f\x7f]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The git author. GH_BROKER_GIT_NAME and GH_BROKER_GIT_EMAIL set it; without
 * both, the broker asks GitHub for the App's bot user, as
 * "<slug>[bot]" <<id>+<slug>[bot]@users.noreply.github.com>, once.
 * `onIdentity` gets the identity when it is first known (it writes the
 * author file for host-mode runs). A failed lookup gives null and is tried
 * again after FAILURE_HOLD_MS; the token still works without an author.
 */
export function createIdentitySource({
  name, email, readConfig, token, fetchImpl = fetch, now = Date.now, logger = defaultLogger, onIdentity = () => {},
}) {
  let identity = name && email ? { name, email } : null;
  let announced = false;
  let retryAt = 0;
  let inFlight = null;
  async function lookup() {
    const config = readConfig();
    const app = await fetchImpl(`${GITHUB_API}/app`, {
      headers: githubHeaders(`Bearer ${appJwt({ ...config, now: now() })}`),
      redirect: "error", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!app.ok) throw await githubFault(app, "app lookup");
    const slug = (await app.json())?.slug;
    if (typeof slug !== "string" || !/^[a-z0-9-]{1,100}$/i.test(slug)) throw new BrokerError("app lookup: no slug");
    const login = `${slug}[bot]`;
    const { token: installationToken } = await token();
    const user = await fetchImpl(`${GITHUB_API}/users/${encodeURIComponent(login)}`, {
      headers: githubHeaders(`token ${installationToken}`),
      redirect: "error", signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!user.ok) throw await githubFault(user, "bot user lookup");
    const id = (await user.json())?.id;
    if (!Number.isSafeInteger(id)) throw new BrokerError("bot user lookup: no id");
    return { name: login, email: `${id}+${login}@users.noreply.github.com` };
  }
  // waitMs: how long a caller waits for a lookup. A request for credentials
  // waits a short time only: the launcher gives up after 10 s, and the token
  // works without an author.
  return async function author({ waitMs = Infinity } = {}) {
    if (!identity && !inFlight && now() >= retryAt) {
      inFlight = lookup().then((found) => { identity = found; }, (error) => {
        retryAt = now() + FAILURE_HOLD_MS;
        logger(`no git author: ${error instanceof BrokerError ? error.message : "lookup failed"}`);
      }).finally(() => { inFlight = null; });
    }
    if (!identity && inFlight) {
      let timer;
      await Promise.race([inFlight, new Promise((resolve) => {
        if (Number.isFinite(waitMs)) timer = setTimeout(resolve, waitMs);
      })]);
      clearTimeout(timer);
    }
    if (identity && !announced) {
      announced = true;
      logger(`git author: ${identity.name} <${identity.email}>`);
      try { onIdentity(identity); } catch (error) { logger(`cannot write the author file: ${error.code ?? error.message}`); }
    }
    return identity;
  };
}

/** Writes a git config include with the author, atomically. */
export function writeAuthorFile(file, identity) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `# Written by gh-broker: the GitHub App's bot user.\n[user]\n\tname = ${gitConfigValue(identity.name)}\n\temail = ${gitConfigValue(identity.email)}\n`, { mode: 0o644 });
  renameSync(temporary, file);
}

/**
 * The environment for an "available" answer, in the form that Paperclip's
 * own broker gives (server/src/services/git-credentials.ts,
 * buildGitAuthInvocation). The empty helper clears ambient helpers; the
 * token helper is URL-scoped to https://github.com; ssh remotes on GitHub
 * become https remotes, because a managed run has no SSH key.
 */
export function credentialEnvironment(token, author) {
  const entries = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", GIT_CREDENTIAL_HELPER],
    ["credential.https://www.github.com.helper", GIT_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["url.https://github.com/.insteadOf", "git@www.github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@www.github.com/"],
    ...(author ? [["user.name", author.name], ["user.email", author.email]] : []),
  ];
  return {
    PAPERCLIP_GIT_TOKEN: token,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    ...(author ? {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    } : {}),
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
  };
}

/** The request path without the query, safe to log. */
export function loggablePath(url) {
  return String(url ?? "").split("?")[0].replace(/[^\x21-\x7e]/g, "?").slice(0, 120);
}

/** Reads and drops the body, up to `limit` bytes. False when it is larger. */
async function drain(req, limit) {
  const length = Number(req.headers["content-length"]);
  if (length > limit) return false;
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) return false;
  }
  return true;
}

function reply(res, status, body, headers = {}) {
  const text = body === undefined ? "" : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "cache-control": "no-store",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  });
  res.end(text);
}

/**
 * The HTTP server. `token` and `author` come from createTokenSource and
 * createIdentitySource. `configError` is a fault in the broker's own
 * configuration: every request for credentials then gets "unavailable".
 */
export function createBroker({ token, author, configError = null, logger = defaultLogger }) {
  return http.createServer(async (req, res) => {
    const where = `${req.method} ${loggablePath(req.url)}`;
    try {
      if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200); res.end("ok\n"); return; }
      if (req.method !== "POST" || req.url !== CREDENTIALS_PATH) {
        // Do not read the body of a request that is not for the broker.
        logger(where, "404");
        res.writeHead(404, { connection: "close" }); res.end();
        return;
      }
      // Paperclip refuses browser requests on this route; so does the broker.
      if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) {
        logger(where, "403 browser request");
        reply(res, 403, { error: "GitHub credentials require runtime authentication" }, { connection: "close" });
        return;
      }
      if (!(await drain(req, MAX_BODY_BYTES))) {
        logger(where, "413");
        res.writeHead(413, { connection: "close" }); res.end();
        return;
      }
      if (configError) {
        logger(where, "unavailable:", configError.message);
        reply(res, 200, { status: "unavailable", reason: `GitHub broker: ${configError.message}`, env: {} });
        return;
      }
      let minted;
      try { minted = await token(); } catch (error) {
        const reason = error instanceof BrokerError ? error.message : "GitHub could not be reached";
        logger(where, "unavailable:", reason);
        reply(res, 200, { status: "unavailable", reason: `GitHub broker: ${reason}`, env: {} });
        return;
      }
      const identity = await author({ waitMs: AUTHOR_WAIT_MS });
      logger(where, "available");
      reply(res, 200, {
        status: "available",
        authenticationMode: "managed",
        source: "dedicated",
        ...(identity ? { login: identity.name } : {}),
        env: credentialEnvironment(minted.token, identity),
      });
    } catch (error) {
      logger(where, "error:", error instanceof BrokerError ? error.message : (error?.code ?? "internal error"));
      if (!res.headersSent) { res.writeHead(500, { connection: "close" }); res.end(); } else res.destroy();
    }
  });
}

/** True for an error that a network or upstream fault causes. */
export function isNetworkError(error) {
  if (error instanceof BrokerError) return true;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return true;
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === "string" && /^(E[A-Z]+|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|ERR_SSL_|ERR_TLS_)/.test(code)) return true;
  return error instanceof TypeError && error.message === "fetch failed";
}

/**
 * Listens, and tries again every `retryMs` while the port is taken: a run
 * can bind 127.0.0.1:3100 while the broker restarts. Exiting would restart
 * the container in a loop and make the runner pod NotReady, which stops SSH
 * for every agent (the lesson of DIL-973).
 */
export function listenWithRetry(server, port, host, { retryMs = 1000, logger = defaultLogger } = {}) {
  return new Promise((resolve) => {
    let warned = false;
    const attempt = () => {
      // Any listen error (a taken port, or a bad GH_BROKER_HOST or
      // GH_BROKER_PORT) is logged once and tried again, never thrown.
      const onError = (error) => {
        if (!warned) {
          warned = true;
          logger(error.code === "EADDRINUSE"
            ? `${host}:${port} is taken by another process; trying again every ${retryMs} ms`
            : `cannot listen on ${host}:${port} (${error.code ?? "error"}); trying again every ${retryMs} ms`);
        }
        setTimeout(attempt, retryMs).unref?.();
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        // A later server error is logged; it must not stop the broker.
        server.on("error", (error) => logger(`server error: ${error.code ?? "error"}`));
        logger(`listening on ${host}:${port}`);
        resolve(server);
      });
    };
    attempt();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const port = Number(env.GH_BROKER_PORT ?? 3100);
  // Loopback only: the runs reach the broker through hostAliases.
  const host = env.GH_BROKER_HOST ?? "127.0.0.1";
  const secretDir = env.GH_BROKER_SECRET_DIR ?? DEFAULT_SECRET_DIR;
  const authorFile = env.GH_BROKER_AUTHOR_FILE ?? "";
  let repositories = [];
  let configError = null;
  try { repositories = parseRepositories(env.GH_BROKER_REPOSITORIES); } catch (error) { configError = error; }
  if (configError) defaultLogger(configError.message);
  else defaultLogger(`repositories: ${repositories.join(", ") || "(none)"}`);
  if (!env.HTTPS_PROXY && !env.https_proxy) defaultLogger("no HTTPS_PROXY: GitHub is called directly");
  const readConfig = () => readAppConfig(secretDir);
  const token = createTokenSource({ readConfig, repositories });
  const author = createIdentitySource({
    name: env.GH_BROKER_GIT_NAME, email: env.GH_BROKER_GIT_EMAIL, readConfig, token,
    onIdentity: authorFile ? (identity) => writeAuthorFile(authorFile, identity) : undefined,
  });
  const server = createBroker({ token, author, configError });
  listenWithRetry(server, port, host).then(() => {
    // The author file for host-mode runs, as soon as the App answers.
    if (!configError) author().catch(() => {});
  });
  // A GitHub fault must never stop the broker (see listenWithRetry). Any
  // other error is a fault in the broker: exit, and the kubelet restarts it.
  process.on("unhandledRejection", (error) => {
    defaultLogger("unhandled rejection:", error instanceof BrokerError ? error.message : (error?.code ?? error?.name ?? "error"));
    if (!isNetworkError(error)) process.exit(1);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      setTimeout(() => process.exit(0), 3000).unref();
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
