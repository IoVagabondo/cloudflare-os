FROM node:24.19.0-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
ENV NODE_ENV=production
ENV WRANGLER_SEND_METRICS=false
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV HOME=/tmp/workerd-home
ENV PORT=3000
ENV WORKERD_INTERNAL_PORT=8787
ENV WORKERD_PERSIST_PATH=/data

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      gosu \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
COPY . .

# The image carries the exact lockfile-pinned Wrangler and workerd versions. Generated UI and
# frontend artifacts are baked once here; runtime startup only generates binding configs and lets
# Wrangler bundle the immutable Worker sources.
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @gadgets/typed-storage build \
    && pnpm --filter @gadgets/workshop-frontend exec vite build \
    && node packages/workshop-backend/scripts/build-format-blueprints.mjs \
    && pnpm exec vp run -r --cache build:configurator --dev \
    && pnpm exec vp run -r --cache build:app:dev \
    && chmod 0755 railway/workerd/entrypoint.sh \
    && chown -R node:node /app

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/app/railway/workerd/entrypoint.sh"]
