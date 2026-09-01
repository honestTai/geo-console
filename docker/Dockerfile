FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json biome.json ./
COPY apps ./apps
COPY packages/core ./packages/core
COPY packages/evidence ./packages/evidence
COPY packages/metrics ./packages/metrics
COPY packages/logging ./packages/logging
COPY packages/search-providers ./packages/search-providers
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @geo/web build

FROM caddy:2.10.2-alpine AS web
COPY --from=build /app/apps/web/dist /srv/app
COPY landing /srv
COPY docker/caddy/Web.Caddyfile /etc/caddy/Caddyfile

FROM build AS worker
ENV NODE_ENV=production GEO_WORKER_HOST=0.0.0.0 GEO_WORKER_PORT=3010
RUN pnpm --filter @geo/worker exec playwright install --with-deps chromium \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends fonts-noto-cjk \
	&& rm -rf /var/lib/apt/lists/*
CMD ["corepack", "pnpm", "--filter", "@geo/worker", "start"]
