// Token broker for Google Antigravity's ACP server (agy-acp), run in its own
// pod next to the runner (DIL-973). The runner's agents all share one user, so
// a Google token in their home would be readable by every agent. The broker
// keeps the real token in its own pod. agy gets a dummy credential and sends
// its traffic here through HTTPS_PROXY:
//
// - oauth2.googleapis.com: a refresh of the dummy refresh token gets the dummy
//   access token. The broker refuses every other token request.
// - cloudcode-pa and daily-cloudcode-pa: a /v1internal request that carries
//   the dummy access token goes upstream with the real access token. The broker
//   refuses every other request to these hosts.
// - Any other host on port 443: a plain tunnel, without TLS termination.
//
// The broker terminates TLS for those three hosts with its own certificate.
// agy trusts it through a CA bundle that agy-acp builds. The dummy values are
// not secret: an agent that reads them can send prompts through the broker,
// but it cannot read the real token or reach other Google APIs.
//
// The broker does not authenticate its callers. In a sidecar, the loopback
// address kept other pods out. In its own pod, the broker listens on all
// addresses. A NetworkPolicy admits only the runner pods from the cluster.
// kube-router also admits traffic from the pod's own node, so processes and
// hostNetwork pods on that node can connect too. Caller authentication is a
// follow-up (DIL-973).
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const DUMMY_REFRESH_TOKEN = "agy-broker-dummy-refresh-token";
export const DUMMY_ACCESS_TOKEN = "agy-broker-dummy-access-token";
export const OAUTH_HOST = "oauth2.googleapis.com";
export const CCPA_HOSTS = new Set(["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"]);
export const TERMINATED_HOSTS = new Set([OAUTH_HOST, ...CCPA_HOSTS]);
// agy's largest requests carry a conversation; 16 MiB is far above them and
// keeps one agent from exhausting the broker's memory.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
// All request bodies in memory at one time, across requests. Four full-size
// bodies fit; the pod's 256Mi memory limit keeps room for Node and the
// streams. Above the budget the broker answers 503, so agy can try again.
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
// The most header-name sets to log. agy sends a few; an agent that varies
// its headers must not fill the log or the memory.
export const MAX_HEADER_SETS = 64;
const TOKEN_URI = "https://oauth2.googleapis.com/token";
// Hop-by-hop headers, headers that fetch sets itself, and headers that must
// not reach Google.
const STRIPPED_HEADERS = [
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding",
  "upgrade", "te", "trailer", "host", "content-length", "accept-encoding",
];
// Headers that could change what a call with the real token does: a method
// override, or an API key that selects another identity. agy has no reason
// to send them. The forward allowlist below replaces this list later.
const DENIED_HEADERS = [
  "x-http-method-override", "x-http-method", "x-method-override", "x-goog-api-key",
  // Selects the project that pays and the quota that applies.
  "x-goog-user-project",
];

/**
 * The header names to forward, from AGY_BROKER_FORWARD_HEADERS (a comma
 * list). null means "forward every header that is not stripped or denied":
 * the list stays empty until the names that agy sends are known (DIL-973).
 */
export function parseHeaderList(text) {
  const names = (text ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

/**
 * The headers to send upstream, and the names that were dropped. Names in
 * the allowlist pass; without an allowlist, every name passes. The stripped
 * and denied names never pass.
 */
export function forwardHeaders(incoming, allowlist) {
  const headers = {};
  const dropped = [];
  for (const [name, value] of Object.entries(incoming)) {
    if (STRIPPED_HEADERS.includes(name) || name === "authorization") continue;
    if (DENIED_HEADERS.includes(name) || (allowlist && !allowlist.has(name))) { dropped.push(name); continue; }
    headers[name] = value;
  }
  return { headers, dropped };
}

const log = (...parts) => console.log("[agy-broker]", ...parts);

/**
 * The upstream URL for a request on a CCPA host, or null. The check runs on
 * the URL that fetch will send, after dot segments are resolved, so that
 * "/v1internal/../v1/..." cannot leave v1internal. Encoded dots, slashes,
 * backslashes and percent signs are refused outright: agy does not send them.
 */
export function upstreamUrl(host, rawPath) {
  if (!CCPA_HOSTS.has(host) || typeof rawPath !== "string" || !rawPath.startsWith("/")) return null;
  // %25 too: a double-encoded dot or slash ("%252e") must not reach Google.
  if (/\.\.|%2e|%2f|%5c|%25|\\/i.test(rawPath)) return null;
  const origin = `https://${host}`;
  let url;
  try { url = new URL(rawPath, origin); } catch { return null; }
  if (url.origin !== origin || !/^\/v1internal[:/]/.test(url.pathname)) return null;
  return url.href;
}

/** Decides what to do with one request on a terminated host. */
export function route({ host, method, path, authorization, form }) {
  if (host === OAUTH_HOST) {
    const ok = method === "POST" && path === "/token"
      && form?.get("grant_type") === "refresh_token"
      && form?.get("refresh_token") === DUMMY_REFRESH_TOKEN;
    return ok ? { action: "dummy-token" } : { action: "deny", reason: "not a dummy refresh" };
  }
  if (CCPA_HOSTS.has(host)) {
    if (authorization !== `Bearer ${DUMMY_ACCESS_TOKEN}`) return { action: "deny", reason: "not the dummy bearer" };
    const url = upstreamUrl(host, path);
    if (!url) return { action: "deny", reason: "not a v1internal path" };
    return { action: "forward", url };
  }
  return { action: "deny", reason: "host not terminated" };
}

/** The credential file for agy: public client values and dummy tokens only. */
export function dummyCredentials(real) {
  return {
    client_id: real.client_id,
    client_secret: real.client_secret,
    ...(real.project_id ? { project_id: real.project_id } : {}),
    refresh_token: DUMMY_REFRESH_TOKEN,
    scopes: real.scopes,
    token_uri: TOKEN_URI,
  };
}

/** Gets real access tokens with the stored refresh token, one refresh at a time. */
export function createTokenSource({ readToken, fetchImpl = fetch, now = Date.now }) {
  let refreshToken = null;
  let cached = null;
  let inFlight = null;
  async function refresh() {
    const real = readToken();
    refreshToken ??= real.refresh_token;
    const response = await fetchImpl(TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: real.client_id,
        client_secret: real.client_secret,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== "string") {
      throw new Error(`refresh failed: HTTP ${response.status} ${body.error ?? ""}`.trim());
    }
    if (typeof body.refresh_token === "string" && body.refresh_token !== refreshToken) {
      // The Secret is read-only, so a rotated token lives only in memory.
      // Re-encrypt the Secret before the next restart if this appears.
      refreshToken = body.refresh_token;
      log("Google rotated the refresh token; the new one is kept in memory only");
    }
    const lifetime = Number(body.expires_in);
    cached = { token: body.access_token, expiresAt: now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000 };
    return cached.token;
  }
  return async function accessToken() {
    if (cached && cached.expiresAt - now() > 120_000) return cached.token;
    inFlight ??= refresh().finally(() => { inFlight = null; });
    return inFlight;
  };
}

class BodyTooLarge extends Error {}
class BufferBudgetSpent extends Error {}

/**
 * Reads the body. reserve(n) takes n bytes of the shared budget and returns
 * false when the budget does not have them.
 */
async function readBody(req, reserve) {
  // A Content-Length above the limit is refused before the body is read.
  const length = Number(req.headers["content-length"]);
  if (length > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks = [];
  let size = 0;
  // A chunked body has no length. Leaving `for await (... of req)` early
  // destroys the socket, and the reply never arrives; this iterator keeps it.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    if (!reserve(chunk.length)) throw new BufferBudgetSpent();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** True for an error that a network or upstream fault causes. */
export function isNetworkError(error) {
  if (error?.name === "AbortError") return true;
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === "string" && /^(E[A-Z]+|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|ERR_SSL_|ERR_TLS_)/.test(code)) return true;
  // fetch rejects with TypeError("fetch failed") and puts the reason in cause.
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  // The token source throws a plain Error when Google refuses a refresh.
  return error?.constructor === Error;
}

/**
 * The HTTP server for requests on terminated hosts. socket.agyHost names the
 * host. logHeaderNames logs the request header names of each new set seen on
 * a forward, never the values. allowlist: see parseHeaderList.
 */
export function createTerminatedServer({
  accessToken, fetchImpl = fetch, logger = log, logHeaderNames = false, allowlist = null,
  bufferBudget = MAX_BUFFERED_BYTES,
}) {
  const seenHeaderSets = new Set();
  let buffered = 0;
  const server = http.createServer(async (req, res) => {
    let held = 0;
    const reserve = (bytes) => {
      if (buffered + bytes > bufferBudget) return false;
      buffered += bytes; held += bytes;
      return true;
    };
    const release = () => { buffered -= held; held = 0; };
    const host = req.socket.agyHost;
    const path = req.url ?? "/";
    const abort = new AbortController();
    // Set when the upstream body fails. The pipeline then closes res too, and
    // that close must not count as a client disconnect.
    let upstreamError = null;
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished && upstreamError === null) clientGone = true;
      abort.abort();
    });
    try {
      let body;
      try { body = await readBody(req, reserve); } catch (error) {
        if (error instanceof BodyTooLarge) {
          logger(host, req.method, "deny body too large");
          res.writeHead(413, { connection: "close" }); res.end(); return;
        }
        if (error instanceof BufferBudgetSpent) {
          release();
          logger(host, req.method, "deny buffer budget spent");
          res.writeHead(503, { connection: "close", "retry-after": "5" }); res.end(); return;
        }
        throw error;
      }
      const decision = route({
        host, method: req.method, path,
        authorization: req.headers.authorization,
        form: host === OAUTH_HOST ? new URLSearchParams(body.toString("utf8")) : undefined,
      });
      logger(host, req.method, path.split("?")[0], decision.action, decision.reason ?? "");
      if (decision.action === "deny") { res.writeHead(403); res.end(); return; }
      if (decision.action === "dummy-token") {
        await accessToken();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: DUMMY_ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" }));
        return;
      }
      const { headers, dropped } = forwardHeaders(req.headers, allowlist);
      if (logHeaderNames) {
        const names = Object.keys(req.headers).sort().join(",");
        if (!seenHeaderSets.has(names) && seenHeaderSets.size < MAX_HEADER_SETS) {
          seenHeaderSets.add(names);
          logger(host, "request header names:", names);
          if (seenHeaderSets.size === MAX_HEADER_SETS) {
            logger(host, `request header names: ${MAX_HEADER_SETS} sets logged, no more are logged`);
          }
        }
      }
      if (dropped.length) logger(host, "dropped header names:", dropped.sort().join(","));
      headers.authorization = `Bearer ${await accessToken()}`;
      const upstream = await fetchImpl(decision.url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        // A redirect would carry the real token past route(); agy gets it instead.
        redirect: "manual",
        signal: abort.signal,
      });
      // Google has the body once it answers.
      release();
      const out = {};
      upstream.headers.forEach((value, name) => {
        if (!STRIPPED_HEADERS.includes(name) && name !== "content-encoding") out[name] = value;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) {
        const source = Readable.fromWeb(upstream.body);
        // Registered before pipeline's own listener, so it runs first.
        source.on("error", (error) => { upstreamError ??= error; });
        await pipeline(source, res);
      } else res.end();
    } catch (error) {
      // A client that went away aborts the upstream call; that is no fault.
      if (clientGone) return;
      const cause = upstreamError ?? error;
      if (cause?.name !== "AbortError") logger(host, req.method, path.split("?")[0], "error:", cause?.message);
      try {
        // After the headers, only a reset tells agy that the stream is incomplete.
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502); res.end();
      } catch { res.destroy(); }
    } finally {
      release();
    }
  });
  server.bufferedBytes = () => buffered;
  return server;
}

export function createBroker({ readToken, tlsOptions, fetchImpl = fetch, logHeaderNames = false, allowlist = null }) {
  const accessToken = createTokenSource({ readToken, fetchImpl });
  const terminated = createTerminatedServer({ accessToken, fetchImpl, logHeaderNames, allowlist });

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200); res.end("ok\n"); return; }
    if (req.method === "GET" && req.url === "/dummy-credentials") {
      try {
        const credentials = dummyCredentials(readToken());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`${JSON.stringify(credentials)}\n`);
      } catch (error) {
        log("dummy-credentials error:", error.message);
        res.writeHead(500); res.end();
      }
      return;
    }
    res.writeHead(404); res.end();
  });

  // Tunnels go to any host on 443. That gives an agent nothing new: the
  // broker's NetworkPolicy allows only DNS and port 443 outside private
  // address space, as the runner's own policy does.
  server.on("connect", (req, socket, head) => {
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText);
    if (port !== 443 || !host) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.on("error", () => socket.destroy());
    if (TERMINATED_HOSTS.has(host)) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) socket.unshift(head);
      const secure = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions, ALPNProtocols: ["http/1.1"] });
      secure.agyHost = host;
      secure.on("error", () => secure.destroy());
      terminated.emit("connection", secure);
      return;
    }
    const upstream = net.connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });

  // closeAllConnections() reaches only the sockets that each server tracks.
  // CONNECT tunnels and the terminated server's TLS sockets are not among
  // them, so the 3 s timer at the end of the file closes those.
  server.shutdown = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
    terminated.closeAllConnections();
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.AGY_BROKER_PORT ?? 8787);
  const listenHost = process.env.AGY_BROKER_HOST ?? "0.0.0.0";
  const tokenFile = process.env.AGY_BROKER_TOKEN_FILE ?? "/run/secrets/agy-broker/token.json";
  const server = createBroker({
    readToken: () => JSON.parse(readFileSync(tokenFile, "utf8")),
    tlsOptions: {
      key: readFileSync(process.env.AGY_BROKER_TLS_KEY ?? "/run/secrets/agy-broker/tls.key"),
      cert: readFileSync(process.env.AGY_BROKER_TLS_CERT ?? "/run/secrets/agy-broker/tls.crt"),
    },
    // On until the header names that agy sends are known (DIL-973). Names
    // only: a value can carry a token.
    logHeaderNames: (process.env.AGY_BROKER_LOG_HEADER_NAMES ?? "1") === "1",
    allowlist: parseHeaderList(process.env.AGY_BROKER_FORWARD_HEADERS),
  });
  // All addresses: the runner connects through a Service. The NetworkPolicy
  // decides who can connect (see the top of this file).
  server.listen(port, listenHost, () => log(`listening on ${listenHost}:${port}`));
  // A token or upstream error must never stop the broker. The request
  // handlers catch their errors; this catches one that they miss. Any other
  // error is a fault in the broker: exit, and the pod restarts it. That no
  // longer touches the runner. A stack holds no request values.
  process.on("unhandledRejection", (error) => {
    log("unhandled rejection:", error?.stack ?? String(error));
    if (!isNetworkError(error)) process.exit(1);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      // Long model streams would hold close() open past the grace period.
      setTimeout(() => process.exit(0), 3000);
      server.shutdown().then(() => process.exit(0));
    });
  }
}
