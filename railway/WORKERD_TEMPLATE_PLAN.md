# Cloudflare OS Railway Template Portfolio

This repository should produce two separately named and separately published Railway templates.
They solve different problems and must not share a production-support claim.

## Template 1: Cloudflare OS Operator

**Status:** production-oriented deployment path.

Railway hosts a small authenticated operator. The operator validates and deploys a pinned official
Cloudflare OS starter release into the user's Cloudflare account. Cloudflare continues to provide
Workers, Durable Objects, Dynamic Workers, Facets, KV, R2, Browser Rendering, and Access.

This is the first public template because it follows Cloudflare's currently documented production
deployment model.

## Template 2: Cloudflare OS Workerd Lab

**Status:** experimental portability project; do not market as production-ready.

Railway hosts the Cloudflare Workers runtime itself. The goal is to preserve the Cloudflare OS
Worker code and capability graph while replacing Cloudflare-hosted platform services with local or
Railway-hosted equivalents.

### Stage B0: compatibility proof

**Implementation status:** in progress on the `railway-workerd` branch. The container, persistent
Wrangler launch mode, authenticated HTTP/WebSocket supervisor, and Railway IaC are implemented under
`railway/workerd/`. Runtime, restart, and volume acceptance evidence must be recorded before this
status is promoted beyond experimental.

Package the repository's existing multi-Worker local topology in one Railway service:

- Build all required Worker and frontend artifacts at image-build time.
- Start the pinned Wrangler/Miniflare/workerd stack without source watchers.
- Bind the public listener to Railway's `PORT`.
- Persist `.wrangler` state under a Railway volume mounted at `/data`.
- Run exactly one service replica.
- Generate password and session secrets through Railway template functions.
- Disable or explicitly mark features whose local binding is unavailable.

B0 deliberately uses Cloudflare's development simulator. Its purpose is to establish compatibility,
measure memory and startup behavior, test state persistence, and discover missing bindings. It is not
eligible for marketplace publication as a production template.

### Stage B1: direct workerd distribution

Replace the development host with a generated, pinned `workerd` configuration and production Worker
bundles:

- Preserve the router, Workshop backend, and Gatekeepers as services in one workerd capability graph.
- Configure Dynamic Worker Loader and Durable Object Facets directly.
- Store Durable Object SQLite files on the mounted Railway volume using workerd's `localDisk` mode.
- Provide KV and R2 protocol-compatible services backed by the mounted volume or carefully scoped
  Railway storage services.
- Add a Browser Rendering replacement or leave browser exports disabled with an honest capability
  report.
- Start workerd as an unprivileged process with explicit outbound-network restrictions.
- Pin the runtime, generated configuration, application source, and migrations as one release unit.

Do not split each Cloudflare Worker into an independent Railway container. Service bindings, object
identity, Worker Loader, and Facets are runtime capabilities, not ordinary HTTP microservice calls.
Any auxiliary Railway service must communicate over Railway private networking and have a narrow,
documented capability.

## Expected Railway topology

```text
Internet
   |
Railway HTTPS domain
   |
Cloudflare OS workerd host (one replica)
   |-- Railway volume: Durable Object, KV, and object state
   |-- outbound model and OAuth provider APIs
   `-- optional private browser/storage adapter services
```

The workerd host remains single-replica because standalone workerd does not distribute Durable
Objects across a cluster, and Railway services with attached volumes cannot use replicas. A volume
also introduces a brief restart window during deployment.

## Security boundary

Cloudflare warns that standalone workerd is not, by itself, a hardened sandbox for possibly
malicious Worker code. Cloudflare OS intentionally executes AI-generated Gadget code, so B1 must not
be described as secure merely because it runs inside workerd or a container. Marketplace publication
requires a written threat model and an authorized security assessment of escape containment,
outbound-network denial, capability isolation, authentication, and cross-user data isolation.

## Acceptance gates for B1

1. Fresh install reaches a ready endpoint without manual filesystem changes.
2. User, workspace, Gadget, KV, and object data survive restart and redeploy.
3. Backup and restore recover a coherent snapshot of all local state.
4. An upgrade preserves Durable Object identities and passes rollback rehearsal.
5. Gadget code cannot reach private Railway services or arbitrary internet destinations.
6. Gatekeeper capabilities cannot be forged, widened, or made ambient by a Gatekeeper.
7. Two users and two workspaces remain isolated under concurrent WebSocket and RPC activity.
8. OAuth callbacks, password/session handling, and administrator checks work at the final domain.
9. Resource limits prevent one Gadget from exhausting the whole runtime.
10. Browser export is either validated end-to-end or visibly unavailable.
11. The pinned build passes the upstream unit, workerd, and integration suites.
12. A 72-hour Railway soak has no state loss, wedged runtime, or unbounded resource growth.

## Repository and marketplace strategy

Use separate source repositories or clearly separated release branches:

- `cloudflare-os-railway-operator`: supported Cloudflare deployment operator.
- `cloudflare-os-railway-workerd`: experimental self-hosted runtime.

Separate templates prevent users from mistaking the portability lab for Cloudflare's supported
deployment route. Publish B0 privately for testers. Publish B1 publicly only after every acceptance
gate passes, with “Community” and “Experimental” visible in the name and overview.

## Primary references

- Cloudflare OS self-hosting status: <https://github.com/cloudflare/cloudflare-os/blob/main/README.md>
- workerd configuration: <https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp>
- workerd security warning: <https://github.com/cloudflare/workerd/blob/main/README.md>
- Railway Infrastructure as Code: <https://docs.railway.com/infrastructure-as-code>
- Railway volume limits: <https://docs.railway.com/volumes/reference>
- Railway private networking: <https://docs.railway.com/networking/private-networking>
