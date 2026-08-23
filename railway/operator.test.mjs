import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeploymentConfig,
  createOperatorServer,
  isAuthorized,
  isSameOrigin,
  missingDeploymentVariables,
  sanitizeOutput,
} from "./operator.mjs";

function baseEnv() {
  return {
    CLOUDFLARE_API_TOKEN: "cloudflare-secret-token",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_OS_PREFIX: "my-os",
    CLOUDFLARE_OS_PUBLIC_URL: "https://my-os-router.example.workers.dev",
    CLOUDFLARE_ACCESS_ISSUER: "https://my-team.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "access-audience",
    CLOUDFLARE_OS_ADMIN_EMAIL: "admin@example.com,owner@example.com",
    CLOUDFLARE_OS_STARTER_REF: "starter-sha",
    OPERATOR_PASSWORD: "operator-secret",
  };
}

function basicAuth(value) {
  return `Basic ${Buffer.from(value).toString("base64")}`;
}

test("builds the official starter configuration for workers.dev", () => {
  const config = buildDeploymentConfig(baseEnv());
  assert.deepEqual(config.workers.router, {
    name: "my-os-router",
    route: { workersDev: true },
  });
  assert.equal(config.publicBaseUrl, "https://my-os-router.example.workers.dev");
  assert.deepEqual(config.access.admins, ["admin@example.com", "owner@example.com"]);
  assert.deepEqual(config.aiGateway.providers, ["cloudflare"]);
  assert.equal(config.resources.blueprintContentBucket, null);
});

test("derives a custom-domain route without duplicating the public origin", () => {
  const env = baseEnv();
  env.CLOUDFLARE_OS_PUBLIC_URL = "https://os.example.com";
  const config = buildDeploymentConfig(env);
  assert.deepEqual(config.workers.router.route, { customDomain: "os.example.com" });
  assert.equal(config.publicBaseUrl, null);
});

test("fails closed when the workers.dev hostname does not name the router", () => {
  const env = baseEnv();
  env.CLOUDFLARE_OS_PUBLIC_URL = "https://different.example.workers.dev";
  assert.throws(() => buildDeploymentConfig(env), /my-os-router/);
});

test("fails closed on AI Gateway modes that need a pre-deploy Workshop secret", () => {
  const google = baseEnv();
  google.CLOUDFLARE_AI_GATEWAY_PROVIDERS = "cloudflare,google";
  assert.throws(() => buildDeploymentConfig(google), /subset/);

  const crossAccount = baseEnv();
  crossAccount.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
  assert.throws(() => buildDeploymentConfig(crossAccount), /Cross-account/);
});

test("reports missing deployment variables without exposing values", () => {
  const env = baseEnv();
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCESS_AUDIENCE;
  assert.deepEqual(missingDeploymentVariables(env), [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCESS_AUDIENCE",
  ]);
});

test("basic authentication requires the admin username and exact password", () => {
  assert.equal(isAuthorized(basicAuth("admin:operator-secret"), "operator-secret"), true);
  assert.equal(isAuthorized(basicAuth("root:operator-secret"), "operator-secret"), false);
  assert.equal(isAuthorized(basicAuth("admin:wrong"), "operator-secret"), false);
  assert.equal(isAuthorized(undefined, "operator-secret"), false);
});

test("release operations accept only the operator origin", () => {
  assert.equal(isSameOrigin({ host: "localhost:3000" }), true);
  assert.equal(isSameOrigin({
    origin: "https://operator.up.railway.app",
    "x-forwarded-host": "operator.up.railway.app",
    "x-forwarded-proto": "https",
  }), true);
  assert.equal(isSameOrigin({
    origin: "https://attacker.example",
    "x-forwarded-host": "operator.up.railway.app",
    "x-forwarded-proto": "https",
  }), false);
});

test("known secrets are redacted from subprocess output", () => {
  const output = sanitizeOutput(
    "token=cloudflare-secret-token password=operator-secret",
    baseEnv(),
  );
  assert.equal(output, "token=[REDACTED] password=[REDACTED]");
});

test("health is public but the operator surface requires authentication", async (t) => {
  const server = createOperatorServer({ env: baseEnv(), starterDir: "/tmp/not-used" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).configured, true);

  const home = await fetch(origin);
  assert.equal(home.status, 401);
  assert.match(home.headers.get("www-authenticate"), /Basic/);
});
