import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_PUBLIC_PORT = 3000;
const DEFAULT_INTERNAL_PORT = 8787;
const DEFAULT_PERSIST_PATH = "/data";
const DEFAULT_START_TIMEOUT_MS = 300_000;

function parseInteger(name, raw, fallback, minimum, maximum) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function equalText(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

/** Return true only for the configured HTTP Basic credentials. */
export function isAuthorized(header, username, password) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return equalText(decoded.slice(0, separator), username) &&
    equalText(decoded.slice(separator + 1), password);
}

/** Build the immutable Wrangler/workerd launch arguments used by the Railway lab. */
export function buildRuntimeArgs({ internalPort, persistPath }) {
  return [
    join(ROOT, "scripts", "run-dev-server.ts"),
    "--serve-frontend-assets",
    "--skip-preflight-builds",
    "--no-watchers",
    "--port", String(internalPort),
    "--ip", "127.0.0.1",
    "--persist-to", persistPath,
  ];
}

/** Parse and validate the supervisor's environment without returning any secret in errors. */
export function readLabConfig(env = process.env) {
  const publicPort = parseInteger("PORT", env.PORT, DEFAULT_PUBLIC_PORT, 1, 65_535);
  const internalPort = parseInteger(
      "WORKERD_INTERNAL_PORT", env.WORKERD_INTERNAL_PORT, DEFAULT_INTERNAL_PORT, 1, 65_535);
  if (publicPort === internalPort) {
    throw new Error("PORT and WORKERD_INTERNAL_PORT must be different.");
  }

  const username = env.LAB_AUTH_USERNAME?.trim() || "lab";
  if (username.length > 64 || username.includes(":")) {
    throw new Error("LAB_AUTH_USERNAME must be at most 64 characters and cannot contain a colon.");
  }

  const password = env.LAB_AUTH_PASSWORD;
  if (typeof password !== "string" || password.length < 16) {
    throw new Error("LAB_AUTH_PASSWORD must contain at least 16 characters.");
  }

  const persistPath = env.WORKERD_PERSIST_PATH?.trim() || DEFAULT_PERSIST_PATH;
  if (!isAbsolute(persistPath)) {
    throw new Error("WORKERD_PERSIST_PATH must be an absolute path.");
  }

  return {
    publicPort,
    internalPort,
    username,
    password,
    persistPath,
    startTimeoutMs: parseInteger(
        "WORKERD_START_TIMEOUT_MS", env.WORKERD_START_TIMEOUT_MS,
        DEFAULT_START_TIMEOUT_MS, 1_000, 900_000),
  };
}

function publicHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.authorization;
  delete forwarded["proxy-authorization"];
  // Never trust client-supplied forwarding headers at this public boundary. Railway terminates TLS
  // before this process, while workerd is reachable only over the loopback hop below.
  forwarded["x-forwarded-host"] = headers.host;
  forwarded["x-forwarded-proto"] = "https";
  return forwarded;
}

function sendUnauthorized(response) {
  response.writeHead(401, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "www-authenticate": 'Basic realm="Cloudflare OS Workerd Lab", charset="UTF-8"',
  });
  response.end("Authentication required.\n");
}

function sendSocketUnauthorized(socket) {
  socket.end(
      "HTTP/1.1 401 Unauthorized\r\n" +
      'WWW-Authenticate: Basic realm="Cloudflare OS Workerd Lab", charset="UTF-8"\r\n' +
      "Cache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function proxyHttp(req, response, internalPort) {
  const upstream = httpRequest({
    host: "127.0.0.1",
    port: internalPort,
    method: req.method,
    path: req.url,
    headers: publicHeaders(req.headers),
  }, upstreamResponse => {
    response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Cloudflare OS runtime unavailable.\n");
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function writeUpgradeResponse(socket, response) {
  socket.write(
      `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`);
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
  }
  socket.write("\r\n");
}

function proxyUpgrade(req, socket, head, internalPort) {
  const upstreamRequest = httpRequest({
    host: "127.0.0.1",
    port: internalPort,
    method: req.method,
    path: req.url,
    headers: publicHeaders(req.headers),
  });

  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    writeUpgradeResponse(socket, upstreamResponse);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });
  upstreamRequest.on("response", upstreamResponse => {
    writeUpgradeResponse(socket, upstreamResponse);
    upstreamResponse.pipe(socket);
  });
  upstreamRequest.on("error", () => socket.destroy());
  upstreamRequest.end();
}

/** Create the authenticated public proxy and its readiness endpoint. */
export function createLabServer({ username, password, internalPort, persistPath, isReady }) {
  const server = createServer((req, response) => {
    const pathname = new URL(req.url ?? "/", "http://lab.invalid").pathname;
    if (pathname === "/healthz") {
      const ready = isReady();
      response.writeHead(ready ? 200 : 503, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(JSON.stringify({
        ok: ready,
        ready,
        experimental: true,
        runtime: "wrangler-dev/workerd",
        persistentState: persistPath.length > 0,
      }));
      return;
    }

    if (!isAuthorized(req.headers.authorization, username, password)) {
      sendUnauthorized(response);
      return;
    }
    if (!isReady()) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("Cloudflare OS runtime is starting.\n");
      return;
    }
    proxyHttp(req, response, internalPort);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!isAuthorized(req.headers.authorization, username, password)) {
      sendSocketUnauthorized(socket);
      return;
    }
    if (!isReady()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyUpgrade(req, socket, head, internalPort);
  });
  return server;
}

function probePort(port) {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForRuntime(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    if (await probePort(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (child.exitCode !== null) {
    throw new Error(`Cloudflare OS runtime exited before readiness (code ${child.exitCode}).`);
  }
  throw new Error(`Cloudflare OS runtime did not become ready within ${timeoutMs}ms.`);
}

async function main() {
  const config = readLabConfig();
  let ready = false;
  let shuttingDown = false;

  const runtimeEnv = { ...process.env };
  delete runtimeEnv.LAB_AUTH_PASSWORD;
  delete runtimeEnv.LAB_AUTH_USERNAME;
  runtimeEnv.VITE_BACKEND_HOST = `localhost:${config.internalPort}`;
  if (!runtimeEnv.PUBLIC_BASE_URL && runtimeEnv.RAILWAY_PUBLIC_DOMAIN) {
    runtimeEnv.PUBLIC_BASE_URL = `https://${runtimeEnv.RAILWAY_PUBLIC_DOMAIN}`;
  }

  const child = spawn(process.execPath, buildRuntimeArgs(config), {
    cwd: ROOT,
    env: runtimeEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const server = createLabServer({ ...config, isReady: () => ready });

  server.listen(config.publicPort, "0.0.0.0", () => {
    console.log(`Cloudflare OS Workerd Lab proxy listening on 0.0.0.0:${config.publicPort}.`);
  });

  child.on("error", error => {
    console.error(`Cloudflare OS runtime could not start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    ready = false;
    if (shuttingDown) return;
    console.error(`Cloudflare OS runtime exited (code=${code}, signal=${signal}).`);
    server.close(() => process.exit(code ?? 1));
  });

  try {
    await waitForRuntime(config.internalPort, child, config.startTimeoutMs);
    ready = true;
    console.log("Cloudflare OS workerd runtime is ready.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    child.kill("SIGTERM");
    server.close(() => process.exit(1));
    return;
  }

  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    server.close();
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
