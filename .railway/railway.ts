import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const operator = service("Cloudflare OS Operator", {
    source: github("IoVagabondo/cloudflare-os", { branch: "main" }),
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
  });

  return project("Cloudflare OS Operator", {
    resources: [operator],
  });
});
