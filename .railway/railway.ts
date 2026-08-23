import {
  defineRailway,
  github,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  const state = volume("Cloudflare OS State", {
    // Railway normalizes the legacy europe-west4 alias to this current volume region. Keeping the
    // concrete region avoids an IaC plan trying to replace a populated volume on a later apply.
    region: "europe-west4-drams3a",
    sizeMB: 1024,
  });

  const lab = service("Cloudflare OS Workerd Lab", {
    source: github("IoVagabondo/cloudflare-os", { branch: "railway-workerd" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "/Dockerfile",
      watchPatterns: [
        "/Dockerfile",
        "/.dockerignore",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/vite.config.ts",
        "/tsconfig.json",
        "/scripts/**",
        "/packages/**",
        "/railway/workerd/entrypoint.sh",
        "/railway/workerd/supervisor.mjs",
      ],
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 600,
    replicas: { "europe-west4": 1 },
    volumeMounts: { "/data": state },
    env: {
      LAB_AUTH_USERNAME: "lab",
      LAB_AUTH_PASSWORD: preserve(),
      CLOUDFLARE_OAUTH_CLIENT_ID: preserve(),
      CLOUDFLARE_OAUTH_CLIENT_SECRET: preserve(),
      CONFLUENCE_CLIENT_ID: preserve(),
      CONFLUENCE_CLIENT_SECRET: preserve(),
      GITHUB_CLIENT_ID: preserve(),
      GITHUB_CLIENT_SECRET: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      LINEAR_CLIENT_ID: preserve(),
      LINEAR_CLIENT_SECRET: preserve(),
      PORT: "3000",
      PUBLIC_BASE_URL: preserve(),
      WORKERD_INTERNAL_PORT: "8787",
      WORKERD_PERSIST_PATH: "/data",
      WORKERD_START_TIMEOUT_MS: "480000",
    },
  });

  return project("Cloudflare OS Workerd Lab", {
    resources: [lab, state],
  });
});
