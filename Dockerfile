FROM node:24.19.0-bookworm-slim

ARG CLOUDFLARE_OS_STARTER_REF=3d211477ad009e13a98d863d843e5c12a29ad02b

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /opt/cloudflare-os-starter

# The official starter is the production deployment contract. Pinning the commit makes the build
# reproducible and prevents an unreviewed upstream change from silently changing the trust boundary.
RUN git init \
    && git remote add origin https://github.com/cloudflare/cloudflare-os-starter.git \
    && git fetch --depth 1 origin "$CLOUDFLARE_OS_STARTER_REF" \
    && git checkout --detach FETCH_HEAD \
    && git submodule update --init --depth 1

RUN pnpm install --frozen-lockfile \
    && pnpm --dir cloudflare-os install --frozen-lockfile

COPY railway/operator.mjs /opt/railway-operator/operator.mjs

ENV CLOUDFLARE_OS_STARTER_DIR=/opt/cloudflare-os-starter
ENV CLOUDFLARE_OS_STARTER_REF=$CLOUDFLARE_OS_STARTER_REF
ENV NODE_ENV=production
ENV PORT=3000

RUN chown -R node:node /opt/cloudflare-os-starter /opt/railway-operator

USER node

EXPOSE 3000

CMD ["node", "/opt/railway-operator/operator.mjs"]
