import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";

import {
  buildRuntimeArgs,
  createLabServer,
  isAuthorized,
  readLabConfig,
} from "./supervisor.mjs";

const USERNAME = "lab";
const PASSWORD = "a-secure-test-password";
const AUTHORIZATION = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

test("validates the Railway lab configuration", () => {
  assert.deepEqual(readLabConfig({
    PORT: "3000",
    WORKERD_INTERNAL_PORT: "8787",
    WORKERD_PERSIST_PATH: "/data",
    LAB_AUTH_USERNAME: USERNAME,
    LAB_AUTH_PASSWORD: PASSWORD,
  }), {
    publicPort: 3000,
    internalPort: 8787,
    persistPath: "/data",
    username: USERNAME,
    password: PASSWORD,
    startTimeoutMs: 300_000,
  });

  assert.throws(
      () => readLabConfig({ PORT: "3000", WORKERD_INTERNAL_PORT: "3000",
        LAB_AUTH_PASSWORD: PASSWORD }),
      /must be different/);
  assert.throws(() => readLabConfig({ LAB_AUTH_PASSWORD: "short" }), /at least 16/);
  assert.throws(
      () => readLabConfig({ LAB_AUTH_PASSWORD: PASSWORD, WORKERD_PERSIST_PATH: "relative" }),
      /absolute path/);
});

test("builds a non-watching persistent workerd launch", () => {
  const args = buildRuntimeArgs({ internalPort: 8787, persistPath: "/data" });
  assert.deepEqual(args.slice(1), [
    "--serve-frontend-assets",
    "--skip-preflight-builds",
    "--no-watchers",
    "--port", "8787",
    "--ip", "127.0.0.1",
    "--persist-to", "/data",
  ]);
});

test("requires exact Basic credentials", () => {
  assert.equal(isAuthorized(AUTHORIZATION, USERNAME, PASSWORD), true);
  assert.equal(isAuthorized(AUTHORIZATION, USERNAME, "wrong-password-value"), false);
  assert.equal(isAuthorized(undefined, USERNAME, PASSWORD), false);
  assert.equal(isAuthorized("Bearer token", USERNAME, PASSWORD), false);
});

test("health is public while HTTP and WebSocket traffic is authenticated", async () => {
  let ready = false;
  let upstreamAuthorization = "not-seen";
  let upstreamForwardedHost = "not-seen";
  let upstreamForwardedProto = "not-seen";
  const upstream = createServer((req, response) => {
    upstreamAuthorization = req.headers.authorization ?? "";
    upstreamForwardedHost = req.headers["x-forwarded-host"] ?? "";
    upstreamForwardedProto = req.headers["x-forwarded-proto"] ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`upstream:${req.url}`);
  });
  upstream.on("upgrade", (req, socket) => {
    upstreamAuthorization = req.headers.authorization ?? "";
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello");
    socket.end();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createLabServer({
    username: USERNAME,
    password: PASSWORD,
    internalPort: upstreamPort,
    persistPath: "/data",
    isReady: () => ready,
  });
  const proxyPort = await listen(proxy);

  try {
    let response = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      ready: false,
      experimental: true,
      runtime: "wrangler-dev/workerd",
      persistentState: true,
    });

    response = await fetch(`http://127.0.0.1:${proxyPort}/`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /Basic/);

    ready = true;
    response = await fetch(`http://127.0.0.1:${proxyPort}/path?q=1`, {
      headers: {
        authorization: AUTHORIZATION,
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "upstream:/path?q=1");
    assert.equal(upstreamAuthorization, "");
    assert.equal(upstreamForwardedHost, `127.0.0.1:${proxyPort}`);
    assert.equal(upstreamForwardedProto, "https");

    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    await once(socket, "connect");
    socket.write(
        "GET /api HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${proxyPort}\r\n` +
        "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
        `Authorization: ${AUTHORIZATION}\r\n\r\n`);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { received += chunk; });
    await once(socket, "end");
    assert.match(received, /101 Switching Protocols/);
    assert.match(received, /hello/);
    assert.equal(upstreamAuthorization, "");
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
