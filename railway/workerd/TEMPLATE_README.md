# Deploy and Host Cloudflare OS Workerd Lab

Cloudflare OS Workerd Lab is a community experiment that runs the Cloudflare OS Worker topology
directly on Railway through the lockfile-pinned Wrangler and `workerd` runtime. Unlike Cloudflare OS
Operator, this template does not deploy application Workers into a Cloudflare account.

This is an experimental compatibility lab, not Cloudflare's supported production deployment path.
Cloudflare's own repository still says standalone-server deployment guidance is coming soon and
that `pnpm run-local` is not a production server. Do not use this template for untrusted users,
sensitive data, or a production multi-tenant service.

This project is not affiliated with or endorsed by Cloudflare or Railway.

## About Hosting Cloudflare OS Workerd Lab

The template creates one Railway service and one persistent Railway volume. Inside the service:

- Wrangler starts the real Cloudflare OS router, Workshop backend, and Gatekeeper Workers in one
  multi-Worker workerd process.
- Local Durable Object, KV, R2, and Worker Loader state is stored under `/data` on the volume.
- The built Cloudflare OS frontend is served from the same Railway origin.
- A small supervisor exposes `/healthz`, proxies HTTP and WebSocket traffic, and protects the lab
  with generated HTTP Basic credentials.
- Browser Rendering uses the container's local headless Chromium when that local binding is used.

The service must remain single-replica. Wrangler's local state is not a distributed database, and a
Railway volume can be mounted by only one active deployment of this service.

## Common Use Cases

- Explore Cloudflare OS without deploying Workers to a Cloudflare account.
- Test Cloudflare Worker portability on a persistent Railway host.
- Measure workerd startup, memory use, and state behavior in a real container platform.
- Develop a future direct-workerd configuration while preserving Cloudflare OS's service bindings.
- Reproduce local-runtime bugs with an inspectable, pinned image.

Do not expose this lab to arbitrary users. AI-generated Gadget code runs in the same standalone
runtime and Wrangler local mode does not provide Cloudflare's production isolation boundary.

## Dependencies for Cloudflare OS Workerd Lab Hosting

### Deployment Dependencies

- A Railway account capable of building the large Cloudflare OS image.
- A Railway volume mounted at `/data`; the template creates a 1 GB volume.
- One Railway service replica and one generated HTTP domain.
- Sufficient memory for Wrangler, workerd, the Worker graph, and optional local Chromium. Start with
  at least 2 GB and expect Browser Rendering to require more.
- Provider API credentials added inside Cloudflare OS for AI functionality.

No Cloudflare API token is required for the default local runtime. Workers AI is not locally
simulated, and inbound Cloudflare Email Routing is unavailable.

## Template Variables

| Variable | Required | Template value or instruction |
|---|---:|---|
| `LAB_AUTH_USERNAME` | yes | `lab`; outer HTTP Basic username |
| `LAB_AUTH_PASSWORD` | yes | `${{secret(32)}}`; generated outer HTTP Basic password |
| `PORT` | yes | `3000`; must match the Railway domain target port |
| `PUBLIC_BASE_URL` | yes | `https://${{RAILWAY_PUBLIC_DOMAIN}}`; public callback origin |
| `WORKERD_INTERNAL_PORT` | yes | `8787`; private loopback workerd listener |
| `WORKERD_PERSIST_PATH` | yes | `/data`; must match the volume mount |
| `WORKERD_START_TIMEOUT_MS` | yes | `480000`; permits the initial Worker bundle startup |
| `GITHUB_CLIENT_ID` | no | Optional GitHub OAuth application client ID |
| `GITHUB_CLIENT_SECRET` | no | Optional GitHub OAuth application secret |
| `GOOGLE_CLIENT_ID` | no | Optional Google OAuth application client ID |
| `GOOGLE_CLIENT_SECRET` | no | Optional Google OAuth application secret |
| `CLOUDFLARE_OAUTH_CLIENT_ID` | no | Optional Cloudflare OAuth application client ID |
| `CLOUDFLARE_OAUTH_CLIENT_SECRET` | no | Optional Cloudflare OAuth application secret |

The supervisor removes `LAB_AUTH_PASSWORD` and `LAB_AUTH_USERNAME` from the workerd child process
environment. It also strips the outer `Authorization` header before proxying requests to Workers.

## First Deployment

1. Wait for the deployment health check to become green; the first Worker bundle can take several
   minutes.
2. Open the Railway domain and authenticate with `LAB_AUTH_USERNAME` and `LAB_AUTH_PASSWORD`.
3. Create the first Cloudflare OS account with username `admin`. The local topology designates that
   exact username as an administrator.
4. Open `/admin` and disable new signups before sharing the Basic credentials.
5. Add an AI model/provider credential from the Cloudflare OS model settings.
6. Create a disposable Gadget, restart the service, and verify the account, workspace, and Gadget
   still exist.

Deployments with attached volumes have a short downtime window. Do not detach or replace the volume
unless you intend to lose local Durable Object, KV, and R2 state.

## Current Compatibility Boundary

Validated scope for this experimental release:

- Cloudflare OS router and frontend on a Railway HTTPS domain.
- Cap'n Web WebSocket RPC through the authenticated supervisor.
- Multi-Worker service bindings under Wrangler's local workerd runtime.
- Local Durable Object, KV, R2, and Dynamic Worker Loader storage rooted on `/data`.
- Container restart and redeploy reuse of the same Railway volume.

Not production-supported or not yet accepted:

- Strong containment of hostile or AI-generated Worker code.
- Horizontal replicas, distributed Durable Objects, or zero-downtime volume deploys.
- Cloudflare Email Routing and Workers AI local simulation.
- A coordinated backup/restore and rollback protocol for every local binding.
- The 72-hour soak, cross-user isolation, resource exhaustion, and browser-export gates documented in
  `railway/WORKERD_TEMPLATE_PLAN.md`.

## Implementation Details

The image pins Node through `node:24.19.0-bookworm-slim` and pins Wrangler/workerd through this
repository's `pnpm-lock.yaml`. Generated frontend and Gatekeeper UI assets are baked at image-build
time. At runtime, `scripts/run-dev-server.ts` generates the multi-Worker configs without watchers,
then starts Wrangler with `--ip 127.0.0.1 --persist-to /data`.

The public supervisor listens on Railway's `PORT`; workerd never binds directly to the public
interface. `/healthz` is deliberately public, contains no secrets, and returns 200 only after the
internal runtime accepts connections. All other HTTP and WebSocket traffic requires Basic auth.
The generated Railway domain must target port `3000`; create it after applying the project IaC.

## Why Deploy the Workerd Lab on Railway?

Railway supplies a reproducible Docker build, public TLS endpoint, persistent volume, health-gated
deployments, logs, and resource metrics. This makes it a useful portability test bed while the
official standalone Cloudflare OS packaging is unfinished. Use Cloudflare OS Operator instead when
you need the supported Cloudflare-hosted production architecture.
