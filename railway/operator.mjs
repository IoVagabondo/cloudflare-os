import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_STARTER_DIR = "/opt/cloudflare-os-starter";
const MAX_LOG_LINES = 800;
// Google and cross-account gateways require a Workshop secret to exist before the official starter
// can deploy. The operator deliberately keeps the first release single-phase, so it offers only the
// in-account providers that do not need that bootstrap secret.
const ALLOWED_AI_PROVIDERS = new Set(["anthropic", "openai", "cloudflare"]);

const REQUIRED_DEPLOYMENT_VARIABLES = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_OS_PREFIX",
  "CLOUDFLARE_OS_PUBLIC_URL",
  "CLOUDFLARE_ACCESS_ISSUER",
  "CLOUDFLARE_ACCESS_AUDIENCE",
  "CLOUDFLARE_OS_ADMIN_EMAIL",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseHttpsOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin.`);
  }
  if (url.protocol !== "https:" || url.origin !== value ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS origin with no path, query, or trailing slash.`);
  }
  return url;
}

function parseEmails(value) {
  const emails = value.split(",").map((email) => email.trim()).filter(Boolean);
  if (!emails.length || !emails.every((email) => /^[^@\s]+@[^@\s]+$/.test(email))) {
    throw new Error("CLOUDFLARE_OS_ADMIN_EMAIL must contain comma-separated email addresses.");
  }
  return emails;
}

function parseProviders(value = "cloudflare") {
  const providers = value.split(",").map((provider) => provider.trim()).filter(Boolean);
  if (!providers.length || !providers.every((provider) => ALLOWED_AI_PROVIDERS.has(provider))) {
    throw new Error(
      "CLOUDFLARE_AI_GATEWAY_PROVIDERS must be a comma-separated subset of " +
      [...ALLOWED_AI_PROVIDERS].join(", ") + ".",
    );
  }
  return [...new Set(providers)];
}

export function missingDeploymentVariables(env) {
  return REQUIRED_DEPLOYMENT_VARIABLES.filter((name) => !nonEmpty(env[name]));
}

export function buildDeploymentConfig(env) {
  const missing = missingDeploymentVariables(env);
  if (missing.length) throw new Error(`Missing required variables: ${missing.join(", ")}.`);

  const accountId = env.CLOUDFLARE_ACCOUNT_ID.trim();
  if (!/^[a-f\d]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be 32 hexadecimal characters.");
  }

  const prefix = env.CLOUDFLARE_OS_PREFIX.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/.test(prefix)) {
    throw new Error(
      "CLOUDFLARE_OS_PREFIX must be 1-45 lowercase letters, numbers, or hyphens, " +
      "and cannot start or end with a hyphen.",
    );
  }

  const publicUrl = parseHttpsOrigin(
    env.CLOUDFLARE_OS_PUBLIC_URL.trim(),
    "CLOUDFLARE_OS_PUBLIC_URL",
  );
  const accessIssuer = parseHttpsOrigin(
    env.CLOUDFLARE_ACCESS_ISSUER.trim(),
    "CLOUDFLARE_ACCESS_ISSUER",
  );
  if (!accessIssuer.hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("CLOUDFLARE_ACCESS_ISSUER must use your cloudflareaccess.com team domain.");
  }

  const routerName = `${prefix}-router`;
  const workersDev = publicUrl.hostname.endsWith(".workers.dev");
  if (workersDev && publicUrl.hostname.split(".")[0] !== routerName) {
    throw new Error(
      `The workers.dev hostname must begin with the router Worker name (${routerName}).`,
    );
  }

  const providers = parseProviders(env.CLOUDFLARE_AI_GATEWAY_PROVIDERS);
  if (nonEmpty(env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID) &&
      env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID.trim().toLowerCase() !== accountId.toLowerCase()) {
    throw new Error(
      "Cross-account AI Gateway is not supported by the one-phase operator. " +
      "Leave CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID blank or set it to CLOUDFLARE_ACCOUNT_ID.",
    );
  }

  return {
    accountId,
    publicBaseUrl: workersDev ? publicUrl.origin : null,
    workers: {
      router: {
        name: routerName,
        route: workersDev ? { workersDev: true } : { customDomain: publicUrl.hostname },
      },
      workshop: { name: `${prefix}-workshop` },
      context: { name: `${prefix}-context` },
      scheduler: { name: `${prefix}-scheduler` },
      customGatekeeper: { name: `${prefix}-custom` },
      errorReporter: { name: `${prefix}-errors` },
    },
    access: {
      issuer: accessIssuer.origin,
      audience: env.CLOUDFLARE_ACCESS_AUDIENCE.trim(),
      admins: parseEmails(env.CLOUDFLARE_OS_ADMIN_EMAIL),
    },
    aiGateway: {
      enabled: true,
      name: nonEmpty(env.CLOUDFLARE_AI_GATEWAY_NAME)
        ? env.CLOUDFLARE_AI_GATEWAY_NAME.trim()
        : "default",
      accountId: null,
      providers,
    },
    context: {
      sharingDomain: null,
      kvNamespaceId: null,
    },
    customGatekeeper: {
      name: nonEmpty(env.CLOUDFLARE_OS_ORGANIZATION_NAME)
        ? env.CLOUDFLARE_OS_ORGANIZATION_NAME.trim()
        : "Organization Context",
      message: nonEmpty(env.CLOUDFLARE_OS_ORGANIZATION_GUIDANCE)
        ? env.CLOUDFLARE_OS_ORGANIZATION_GUIDANCE.trim()
        : "Use the connected organization context only when the user explicitly enables it.",
    },
    errorReporting: {
      enabled: true,
      environment: "production",
      release: nonEmpty(env.CLOUDFLARE_OS_STARTER_REF)
        ? env.CLOUDFLARE_OS_STARTER_REF.trim()
        : null,
    },
    resources: {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    },
    observability: {
      enabled: true,
      headSamplingRate: 0.1,
      logs: { invocationLogs: false },
      traces: { enabled: false, headSamplingRate: 0.1 },
    },
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

export function isAuthorized(authorization, password) {
  if (!nonEmpty(password) || typeof authorization !== "string" ||
      !authorization.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), "admin") &&
    safeEqual(decoded.slice(separator + 1), password);
}

export function sanitizeOutput(value, env) {
  let result = String(value);
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CF_AI_GATEWAY_API_TOKEN",
    "OPERATOR_PASSWORD",
  ]) {
    if (nonEmpty(env[name])) result = result.split(env[name]).join("[REDACTED]");
  }
  return result;
}

export function isSameOrigin(headers) {
  const origin = headers.origin;
  if (!origin) return true;
  const host = headers["x-forwarded-host"] ?? headers.host;
  const proto = headers["x-forwarded-proto"] ?? "http";
  if (!host || (proto !== "http" && proto !== "https")) return false;
  return origin === `${proto}://${host}`;
}

function securityHeaders(nonce) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function renderHome(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cloudflare OS Operator</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font: 16px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #f5efe6; background: #11100f; min-height: 100vh; }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background:
      radial-gradient(circle at 15% 10%, #f6821f2c, transparent 32rem),
      radial-gradient(circle at 85% 30%, #6b7cff1c, transparent 28rem); }
    main { position: relative; width: min(1060px, calc(100% - 2rem)); margin: 0 auto; padding: 4rem 0; }
    .eyebrow { color: #f7a45b; text-transform: uppercase; letter-spacing: .14em; font-size: .75rem; font-weight: 800; }
    h1 { margin: .45rem 0 .6rem; font-size: clamp(2.2rem, 7vw, 5.5rem); line-height: .94; letter-spacing: -.065em; max-width: 900px; }
    .lede { color: #bbb2a8; font-size: 1.08rem; max-width: 760px; }
    .grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 1rem; margin-top: 2.4rem; }
    .card { border: 1px solid #ffffff18; border-radius: 20px; background: #1b1917d9; box-shadow: 0 20px 60px #0005; padding: 1.25rem; backdrop-filter: blur(12px); }
    .wide { grid-column: 1 / -1; }
    h2 { margin: 0 0 .9rem; font-size: 1.02rem; letter-spacing: -.01em; }
    .status { display: inline-flex; align-items: center; gap: .55rem; color: #d9d1c8; }
    .dot { width: .65rem; height: .65rem; border-radius: 50%; background: #a99f95; box-shadow: 0 0 0 4px #a99f9518; }
    .dot.ready, .dot.succeeded { background: #59d994; box-shadow: 0 0 0 4px #59d99418; }
    .dot.running { background: #f7a45b; box-shadow: 0 0 0 4px #f7a45b18; animation: pulse 1.2s infinite; }
    .dot.failed, .dot.incomplete { background: #ff6b6b; box-shadow: 0 0 0 4px #ff6b6b18; }
    @keyframes pulse { 50% { opacity: .45; } }
    dl { display: grid; grid-template-columns: 9.5rem 1fr; gap: .5rem .8rem; margin: 1rem 0 0; }
    dt { color: #8f877f; } dd { margin: 0; overflow-wrap: anywhere; }
    a { color: #ffb26f; }
    .actions { display: flex; flex-wrap: wrap; gap: .65rem; margin-top: 1.2rem; }
    button { border: 0; border-radius: 999px; padding: .75rem 1rem; font: inherit; font-weight: 800; cursor: pointer; color: #17120e; background: #f6821f; }
    button.secondary { color: #f5efe6; background: #35302b; }
    button:disabled { opacity: .42; cursor: not-allowed; }
    .missing { color: #ff9999; margin: .75rem 0 0; padding-left: 1.2rem; }
    pre { margin: 0; min-height: 16rem; max-height: 34rem; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #d7cec5; background: #0d0c0b; border-radius: 14px; padding: 1rem; font: .8rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .foot { color: #827a73; margin-top: 1rem; font-size: .82rem; }
    @media (max-width: 760px) { main { padding-top: 2.5rem; } .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } dl { grid-template-columns: 1fr; } dt { margin-top: .35rem; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Community deployment console</div>
    <h1>Cloudflare OS,<br>under your control.</h1>
    <p class="lede">Railway hosts this authenticated operator. The OS itself deploys into your own Cloudflare account using Cloudflare's pinned official starter and production trust boundary.</p>
    <section class="grid">
      <article class="card">
        <h2>Configuration</h2>
        <div class="status"><span id="config-dot" class="dot"></span><span id="config-label">Loading…</span></div>
        <ul id="missing" class="missing"></ul>
        <dl>
          <dt>Starter</dt><dd id="starter">—</dd>
          <dt>Cloudflare OS</dt><dd id="public-url">—</dd>
          <dt>Worker prefix</dt><dd id="prefix">—</dd>
          <dt>AI providers</dt><dd id="providers">—</dd>
        </dl>
      </article>
      <article class="card">
        <h2>Release operation</h2>
        <div class="status"><span id="run-dot" class="dot"></span><span id="run-label">Idle</span></div>
        <p class="lede">Validate runs the official full test/build and Wrangler dry run. Deploy mutates only the Cloudflare account named by your variables.</p>
        <div class="actions">
          <button id="validate" class="secondary">Validate release</button>
          <button id="deploy">Deploy to Cloudflare</button>
        </div>
        <p class="foot">Nothing deploys automatically. A deploy requires this explicit action and is serialized so two releases cannot race.</p>
      </article>
      <article class="card wide">
        <h2>Operation log</h2>
        <pre id="logs">No operation has run in this container.</pre>
      </article>
    </section>
    <p class="foot">Cloudflare OS Operator is a community deployment surface and is not affiliated with or endorsed by Cloudflare or Railway.</p>
  </main>
  <script nonce="${nonce}">
    const byId = (id) => document.getElementById(id);
    let lastPhase = "idle";

    async function status() {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }

    function render(data) {
      const ready = data.missing.length === 0 && !data.configError;
      byId("config-dot").className = "dot " + (ready ? "ready" : "incomplete");
      byId("config-label").textContent = ready ? "Ready to validate" : "Needs configuration";
      byId("missing").replaceChildren(...data.missing.map((name) => {
        const item = document.createElement("li"); item.textContent = name; return item;
      }));
      if (data.configError) {
        const item = document.createElement("li"); item.textContent = data.configError;
        byId("missing").append(item);
      }
      byId("starter").textContent = data.starterRef || "unreported";
      const link = data.summary?.publicUrl;
      byId("public-url").replaceChildren();
      if (link) {
        const anchor = document.createElement("a"); anchor.href = link; anchor.textContent = link;
        anchor.target = "_blank"; anchor.rel = "noreferrer"; byId("public-url").append(anchor);
      } else byId("public-url").textContent = "—";
      byId("prefix").textContent = data.summary?.prefix || "—";
      byId("providers").textContent = data.summary?.providers?.join(", ") || "—";

      const run = data.run;
      byId("run-dot").className = "dot " + run.phase;
      byId("run-label").textContent = run.phase === "idle" ? "Idle" :
        (run.action || "Operation") + ": " + run.phase;
      byId("logs").textContent = run.logs.length ? run.logs.join("\n") :
        "No operation has run in this container.";
      byId("logs").scrollTop = byId("logs").scrollHeight;
      const disabled = !ready || run.phase === "running";
      byId("validate").disabled = disabled;
      byId("deploy").disabled = disabled;
      lastPhase = run.phase;
    }

    async function refresh() {
      try { render(await status()); }
      catch (error) { byId("run-label").textContent = error.message; }
    }

    async function act(action) {
      if (action === "deploy" && !confirm(
        "Deploy this pinned release into the configured Cloudflare account? This creates or updates Workers and storage bindings."
      )) return;
      const response = await fetch("/api/actions/" + action, { method: "POST" });
      if (!response.ok) alert(await response.text());
      await refresh();
    }

    byId("validate").addEventListener("click", () => act("validate"));
    byId("deploy").addEventListener("click", () => act("deploy"));
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function configSummary(config) {
  return {
    publicUrl: config.publicBaseUrl ?? `https://${config.workers.router.route.customDomain}`,
    prefix: config.workers.router.name.replace(/-router$/, ""),
    providers: config.aiGateway.providers,
    admins: config.access.admins,
    workers: Object.fromEntries(
      Object.entries(config.workers).map(([name, worker]) => [name, worker.name]),
    ),
  };
}

export function createOperatorServer({
  env = process.env,
  starterDir = env.CLOUDFLARE_OS_STARTER_DIR || DEFAULT_STARTER_DIR,
} = {}) {
  let child = null;
  const run = {
    phase: "idle",
    action: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    logs: [],
  };

  function appendLog(chunk) {
    const clean = sanitizeOutput(chunk, env).replace(/\r/g, "");
    for (const line of clean.split("\n")) {
      if (line || run.logs.at(-1) !== "") run.logs.push(line);
    }
    if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
  }

  async function startAction(action) {
    if (child) throw new Error("Another release operation is already running.");
    const config = buildDeploymentConfig(env);
    await writeFile(join(starterDir, "deployment.jsonc"), JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    run.phase = "running";
    run.action = action;
    run.startedAt = new Date().toISOString();
    run.finishedAt = null;
    run.exitCode = null;
    run.logs = [`[operator] ${action} started at ${run.startedAt}`];

    const childEnv = { ...env, CI: "true", NO_COLOR: "1" };
    delete childEnv.OPERATOR_PASSWORD;
    child = spawn("pnpm", [action === "validate" ? "check" : "deploy"], {
      cwd: starterDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.once("error", (error) => {
      appendLog(`[operator] failed to start: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      run.exitCode = code;
      run.finishedAt = new Date().toISOString();
      run.phase = code === 0 ? "succeeded" : "failed";
      appendLog(
        `[operator] ${action} ${run.phase} at ${run.finishedAt}` +
        (signal ? ` (signal ${signal})` : ` (exit ${code})`),
      );
      child = null;
    });
  }

  const server = createServer(async (request, response) => {
    const nonce = randomBytes(18).toString("base64");
    const headers = securityHeaders(nonce);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);

    const url = new URL(request.url || "/", "http://operator.invalid");
    if (url.pathname === "/healthz") {
      return sendJson(response, 200, {
        ok: true,
        configured: missingDeploymentVariables(env).length === 0 && nonEmpty(env.OPERATOR_PASSWORD),
        busy: Boolean(child),
      });
    }

    if (!nonEmpty(env.OPERATOR_PASSWORD)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      return response.end("OPERATOR_PASSWORD is not configured.\n");
    }
    if (!isAuthorized(request.headers.authorization, env.OPERATOR_PASSWORD)) {
      response.writeHead(401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Cloudflare OS Operator", charset="UTF-8"',
      });
      return response.end("Authentication required.\n");
    }

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end(renderHome(nonce));
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const missing = missingDeploymentVariables(env);
      let summary = null;
      let configError = null;
      if (!missing.length) {
        try {
          summary = configSummary(buildDeploymentConfig(env));
        } catch (error) {
          configError = error.message;
        }
      }
      return sendJson(response, 200, {
        missing,
        configError,
        summary,
        starterRef: env.CLOUDFLARE_OS_STARTER_REF ?? null,
        run,
      });
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/(validate|deploy)$/);
    if (request.method === "POST" && actionMatch) {
      if (!isSameOrigin(request.headers)) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return response.end("Cross-origin release operations are refused.\n");
      }
      try {
        await startAction(actionMatch[1]);
        return sendJson(response, 202, { accepted: true, action: actionMatch[1] });
      } catch (error) {
        response.writeHead(error.message.includes("already running") ? 409 : 400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        return response.end(`${error.message}\n`);
      }
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.\n");
  });

  server.on("close", () => {
    if (child) child.kill("SIGTERM");
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const server = createOperatorServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Cloudflare OS Operator listening on 0.0.0.0:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
