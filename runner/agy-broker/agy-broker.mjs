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
import { pathToFileURL } from "node:url";

export const DUMMY_REFRESH_TOKEN = "agy-broker-dummy-refresh-token";
export const DUMMY_ACCESS_TOKEN = "agy-broker-dummy-access-token";
export const OAUTH_HOST = "oauth2.googleapis.com";
export const CCPA_HOSTS = new Set(["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"]);
export const TERMINATED_HOSTS = new Set([OAUTH_HOST, ...CCPA_HOSTS]);
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length"];

const log = (...parts) => console.log("[agy-broker]", ...parts);

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
    if (!/^\/v1internal[:/]/.test(path)) return { action: "deny", reason: "not a v1internal path" };
    return { action: "forward" };
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
    cached = { token: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }
  return async function accessToken() {
    if (cached && cached.expiresAt - now() > 120_000) return cached.token;
    inFlight ??= refresh().finally(() => { inFlight = null; });
    return inFlight;
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function createBroker({ tokenFile, tlsKey, tlsCert, fetchImpl = fetch }) {
  const readToken = () => JSON.parse(readFileSync(tokenFile, "utf8"));
  const accessToken = createTokenSource({ readToken, fetchImpl });
  const tlsOptions = { key: readFileSync(tlsKey), cert: readFileSync(tlsCert), ALPNProtocols: ["http/1.1"] };

  const terminated = http.createServer(async (req, res) => {
    const host = req.socket.agyHost;
    const path = req.url ?? "/";
    try {
      const body = await readBody(req);
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
      for (const name of [...HOP_BY_HOP, "accept-encoding"]) delete headers[name];
      const upstream = await fetchImpl(`https://${host}${path}`, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      const out = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.includes(name) && name !== "content-encoding") out[name] = value;
      });
      res.writeHead(upstream.status, out);
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (error) {
      log(host, req.method, path.split("?")[0], "error:", error.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200); res.end("ok\n"); return; }
    if (req.method === "GET" && req.url === "/dummy-credentials") {
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`${JSON.stringify(dummyCredentials(readToken()))}\n`);
      } catch (error) {
        log("dummy-credentials error:", error.message);
        res.writeHead(500); res.end();
      }
      return;
    }
    res.writeHead(404); res.end();
  });

  server.on("connect", (req, socket, head) => {
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText);
    if (port !== 443 || !host) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.on("error", () => socket.destroy());
    if (TERMINATED_HOSTS.has(host)) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) socket.unshift(head);
      const secure = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions });
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

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.AGY_BROKER_PORT ?? 8787);
  const server = createBroker({
    tokenFile: process.env.AGY_BROKER_TOKEN_FILE ?? "/run/secrets/agy-broker/token.json",
    tlsKey: process.env.AGY_BROKER_TLS_KEY ?? "/run/secrets/agy-broker/tls.key",
    tlsCert: process.env.AGY_BROKER_TLS_CERT ?? "/run/secrets/agy-broker/tls.crt",
  });
  // Loopback only: the runner's containers share the pod's network.
  server.listen(port, "127.0.0.1", () => log("listening on 127.0.0.1:" + port));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
