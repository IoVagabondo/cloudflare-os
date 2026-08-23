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
    region: "europe-west4",
    sizeMB: 1024,
  });

  const lab = service("Cloudflare OS Workerd Lab", {
    source: github("IoVagabondo/cloudflare-os", { branch: "railway-workerd" }),
    healthcheck: "/healthz",
    healthcheckTimeout: 600,
    replicas: { "europe-west4": 1 },
    volumeMounts: { "/data": state },
    env: {
      LAB_AUTH_USERNAME: "lab",
      LAB_AUTH_PASSWORD: preserve(),
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
