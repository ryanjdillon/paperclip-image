// Token broker for Google Antigravity's ACP server (agy-acp), run as a sidecar
// next to the runner. The runner's agents all share one user, so a Google
// token in their home would be readable by every agent. The broker keeps the
// real token in its own container. agy gets a dummy credential and sends its
// traffic here through HTTPS_PROXY:
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
// keeps one agent from exhausting the sidecar's memory.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const TOKEN_URI = "https://oauth2.googleapis.com/token";
// Hop-by-hop headers, headers that fetch sets itself, and headers that must
// not reach Google.
const STRIPPED_HEADERS = [
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "transfer-encoding",
  "upgrade", "te", "trailer", "host", "content-length", "accept-encoding",
];

const log = (...parts) => console.log("[agy-broker]", ...parts);

/**
 * The upstream URL for a request on a CCPA host, or null. The check runs on
 * the URL that fetch will send, after dot segments are resolved, so that
 * "/v1internal/../v1/..." cannot leave v1internal. Encoded dots, slashes and
 * backslashes are refused outright: agy does not send them.
 */
export function upstreamUrl(host, rawPath) {
  if (!CCPA_HOSTS.has(host) || typeof rawPath !== "string" || !rawPath.startsWith("/")) return null;
  if (/\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) return null;
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The HTTP server for requests on terminated hosts. socket.agyHost names the host. */
export function createTerminatedServer({ accessToken, fetchImpl = fetch }) {
  return http.createServer(async (req, res) => {
    const host = req.socket.agyHost;
    const path = req.url ?? "/";
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      let body;
      try { body = await readBody(req); } catch (error) {
        if (!(error instanceof BodyTooLarge)) throw error;
        log(host, req.method, "deny body too large");
        res.writeHead(413, { connection: "close" }); res.end(); return;
      }
      const decision = route({
        host, method: req.method, path,
        authorization: req.headers.authorization,
        form: host === OAUTH_HOST ? new URLSearchParams(body.toString("utf8")) : undefined,
      });
      log(host, req.method, path.split("?")[0], decision.action, decision.reason ?? "");
      if (decision.action === "deny") { res.writeHead(403); res.end(); return; }
      if (decision.action === "dummy-token") {
        await accessToken();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: DUMMY_ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" }));
        return;
      }
      const headers = { ...req.headers, authorization: `Bearer ${await accessToken()}` };
      for (const name of STRIPPED_HEADERS) delete headers[name];
      const upstream = await fetchImpl(decision.url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        // A redirect would carry the real token past route(); agy gets it instead.
        redirect: "manual",
        signal: abort.signal,
      });
      const out = {};
      upstream.headers.forEach((value, name) => {
        if (!STRIPPED_HEADERS.includes(name) && name !== "content-encoding") out[name] = value;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (error) {
      if (abort.signal.aborted) return;
      log(host, req.method, path.split("?")[0], "error:", error.message);
      // After the headers, only a reset tells agy that the stream is incomplete.
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502); res.end();
    }
  });
}

export function createBroker({ readToken, tlsOptions, fetchImpl = fetch }) {
  const accessToken = createTokenSource({ readToken, fetchImpl });
  const terminated = createTerminatedServer({ accessToken, fetchImpl });

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

  // Tunnels go to any host on 443, internal ones included. That gives an agent
  // nothing new: the sidecar shares the pod's network and its NetworkPolicy.
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

  server.shutdown = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
    terminated.closeAllConnections();
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.AGY_BROKER_PORT ?? 8787);
  const tokenFile = process.env.AGY_BROKER_TOKEN_FILE ?? "/run/secrets/agy-broker/token.json";
  const server = createBroker({
    readToken: () => JSON.parse(readFileSync(tokenFile, "utf8")),
    tlsOptions: {
      key: readFileSync(process.env.AGY_BROKER_TLS_KEY ?? "/run/secrets/agy-broker/tls.key"),
      cert: readFileSync(process.env.AGY_BROKER_TLS_CERT ?? "/run/secrets/agy-broker/tls.crt"),
    },
  });
  // Loopback only: the runner's containers share the pod's network.
  server.listen(port, "127.0.0.1", () => log("listening on 127.0.0.1:" + port));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      // Long model streams would hold close() open past the grace period.
      setTimeout(() => process.exit(0), 3000);
      server.shutdown().then(() => process.exit(0));
    });
  }
}
