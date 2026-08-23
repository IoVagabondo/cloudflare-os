# Deploy and Manage Cloudflare OS with Railway

Cloudflare OS Operator is a community deployment console for a pinned, self-hosted Cloudflare OS release. Railway hosts the authenticated operator; the Cloudflare OS runtime stays in your Cloudflare account, where its Workers, Durable Objects, Dynamic Workers, KV, R2, Browser Rendering, AI Gateway, and Gatekeepers are supported.

This distinction matters: Cloudflare currently labels production deployment on a standalone `workerd` server as “COMING SOON” and says `pnpm run-local` is not a production server. This template does not rebrand that development command as production hosting.

This project is not affiliated with or endorsed by Cloudflare or Railway. Cloudflare OS is Apache-2.0 licensed; review its license and early-access warning before offering it to users.

## About Hosting Cloudflare OS

The template deploys one small Railway service with an authenticated web console. It generates the official starter configuration from Railway variables and offers two explicit operations:

- **Validate release** runs the official tests, builds, and Wrangler dry runs without deploying Workers.
- **Deploy to Cloudflare** creates or updates the pinned Cloudflare OS Workers and automatically provisioned storage bindings in your account.

No Cloudflare deployment runs automatically. Operations are serialized, subprocess output is bounded, known secrets are redacted, browser actions are same-origin only, and the operator is protected with generated HTTP Basic credentials.

## Common Use Cases

- Deploy a private AI productivity environment for yourself or a team.
- Reproduce the same reviewed Cloudflare OS release across Cloudflare accounts.
- Validate upgrades before changing production Workers.
- Keep Cloudflare credentials in Railway variables instead of a developer laptop.
- Maintain a community template with transparent architecture and a supportable upgrade path.

## Dependencies for Cloudflare OS Hosting

- A Railway project for the operator service.
- A Cloudflare account with access to Workers, KV, R2, Browser Rendering, Dynamic Worker Loaders, and the optional AI products you enable.
- A Cloudflare Access self-hosted application protecting the exact Cloudflare OS hostname.
- A Cloudflare user API token scoped to the deployment account. Cloudflare's Workers build token uses Account Settings read, Workers Scripts edit, Workers KV Storage edit, Workers R2 Storage edit, Workers Routes edit for the relevant zones, User Details read, and Memberships read. Narrow the token to the intended account and zones.

### Why Cloudflare Access is required

The official starter's production trust boundary verifies the Access JWT inside the Workshop. Configure an Allow policy for the intended users before deploying. The template needs the Access issuer (`https://<team>.cloudflareaccess.com`) and the application's audience tag. A broad Everyone or Bypass policy defeats that boundary.

## Template Variables

Configure a generated public Railway domain and set these variables on the operator service. Every secret should have a useful description in the Railway template composer.

| Variable | Required | Template value or instruction |
|---|---:|---|
| `OPERATOR_PASSWORD` | yes | `${{secret(32)}}`; console username is `admin` |
| `CLOUDFLARE_API_TOKEN` | yes | User-provided secret; do not provide a default |
| `CLOUDFLARE_ACCOUNT_ID` | yes | User's 32-character account ID |
| `CLOUDFLARE_OS_PREFIX` | yes | `cfos-${{randomInt(100000,999999)}}`; permanent Worker identity prefix |
| `CLOUDFLARE_OS_PUBLIC_URL` | yes | Exact Access-protected HTTPS origin |
| `CLOUDFLARE_ACCESS_ISSUER` | yes | Exact team origin, no path |
| `CLOUDFLARE_ACCESS_AUDIENCE` | yes | Audience tag from the self-hosted Access application |
| `CLOUDFLARE_OS_ADMIN_EMAIL` | yes | One or more comma-separated Access-verified administrator emails |
| `CLOUDFLARE_AI_GATEWAY_NAME` | no | `default` |
| `CLOUDFLARE_AI_GATEWAY_PROVIDERS` | no | `cloudflare`; `anthropic` and `openai` are supported after their keys are stored on the in-account AI Gateway |
| `CLOUDFLARE_OS_ORGANIZATION_NAME` | no | Display name for the example custom Gatekeeper |
| `CLOUDFLARE_OS_ORGANIZATION_GUIDANCE` | no | Guidance returned by the example custom Gatekeeper |

Do not expose `CLOUDFLARE_API_TOKEN`, AI provider keys, or `OPERATOR_PASSWORD` as public variables. Do not attach a Railway volume: Cloudflare owns the application state, and the console intentionally treats each process restart as a fresh operator session.

## First Deployment

1. Choose the permanent Worker prefix and final Cloudflare OS hostname.
2. Create a Cloudflare Access self-hosted application for that exact hostname and a narrow Allow policy.
3. Create the scoped Cloudflare API token and fill every required Railway variable.
4. Open the generated Railway domain and authenticate as `admin` with `OPERATOR_PASSWORD`.
5. Run **Validate release**. Review the complete successful log.
6. Run **Deploy to Cloudflare** and review the successful Worker deployment sequence.
7. Open the Cloudflare OS URL. Verify an unauthenticated request is denied, an intended administrator can open `/admin`, a non-administrator cannot, and no preview URL bypasses Access.

## Implementation Details

The Docker build pins `cloudflare/cloudflare-os-starter` to commit `3d211477ad009e13a98d863d843e5c12a29ad02b`. That starter pins its Cloudflare OS submodule and derives temporary Wrangler configurations from upstream base files. It deploys the private Workers first and the public router last. Change the Docker build argument only after reviewing upstream changes and completing the validation flow.

The Railway project is described by `.railway/railway.ts`, using Railway's current project-level Infrastructure as Code format. Railway builds the root `Dockerfile`, waits for `/healthz`, and exposes the operator through a generated domain. The health endpoint reports operator availability without exposing configuration values.

## Publishing and Monetization

Build a private demo project first, then create a draft from its production environment:

```bash
railway templates create --project <project-id> --environment production --json
railway templates publish <template-id> \
  --category AI/ML \
  --description "Securely validate, deploy, and upgrade a pinned Cloudflare OS release in your own Cloudflare account." \
  --readme-file railway/TEMPLATE_README.md
```

Add a public demo project only after replacing all credentials with a non-sensitive demonstration configuration. Railway currently documents a 15% base kickback plus a 10% active-support bonus. Questions appear in the Template Queue; answering them is part of maintaining a credible security-sensitive template.

Use a professional workspace identity that accurately represents your relationship to the software. Do not publish under “Cloudflare” unless you are authorized to represent Cloudflare.

## Why Deploy the Operator on Railway?

Railway provides a public health-checked console, encrypted variables, reproducible Docker builds, deployment logs, and a simple template distribution channel. Cloudflare remains the correct execution substrate for Cloudflare OS itself. Together they provide a practical one-click control plane without weakening the product's Workers-native security model.

An experimental second template that hosts the Workers runtime on Railway is tracked separately in `railway/WORKERD_TEMPLATE_PLAN.md`. It is intentionally not presented as a production alternative until its persistence, upgrade, and sandbox acceptance gates pass.
