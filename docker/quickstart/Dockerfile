FROM node:24.16.0-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
WORKDIR /opt/geo-app
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/log-service/package.json ./apps/log-service/package.json
COPY packages/authorization/package.json ./packages/authorization/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/evidence/package.json ./packages/evidence/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/metrics/package.json ./packages/metrics/package.json
COPY packages/search-providers/package.json ./packages/search-providers/package.json
RUN --mount=type=cache,id=zzgeo-quickstart-pnpm,target=/pnpm-store corepack pnpm install --frozen-lockfile --store-dir /pnpm-store --registry=${NPM_REGISTRY}
COPY . .
RUN corepack pnpm --filter @geo/web build
RUN node scripts/export-source.mjs output/docker-source \
    && rm -f landing/source/zzgeo-source.zip \
    && python3 scripts/package-source.py output/docker-source landing/source/zzgeo-source.zip

FROM build AS runtime
ENV NODE_ENV=production GEO_WORKER_HOST=0.0.0.0 GEO_WORKER_PORT=3010
RUN corepack pnpm --filter @geo/worker exec playwright install --with-deps chromium
CMD ["/opt/geo-app/apps/worker/node_modules/.bin/tsx", "/opt/geo-app/apps/worker/src/index.ts"]

FROM caddy:2.10.2-alpine AS web
COPY --from=build /opt/geo-app/apps/web/dist /srv/app
COPY --from=build /opt/geo-app/landing /srv
COPY docker/caddy/Web.Caddyfile /etc/caddy/Caddyfile
