FROM node:24.16.0-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json biome.json ./
COPY apps/web ./apps/web
COPY apps/worker ./apps/worker
COPY apps/log-service ./apps/log-service
COPY packages/core ./packages/core
COPY packages/evidence ./packages/evidence
COPY packages/metrics ./packages/metrics
COPY packages/logging ./packages/logging
COPY packages/search-providers ./packages/search-providers
RUN pnpm config set registry https://registry.npmmirror.com \
	&& pnpm install --frozen-lockfile

FROM caddy:2.10.2-alpine AS web
# Web 静态产物由发布机本地构建（deploy/package.sh 调用 pnpm --filter @geo/web build），
# 服务器镜像只复制 dist，不再在构建期安装前端依赖。
COPY apps/web/dist /srv/app
COPY landing /srv
COPY docker/caddy/Web.Caddyfile /etc/caddy/Caddyfile

FROM build AS worker
ENV NODE_ENV=production GEO_WORKER_HOST=0.0.0.0 GEO_WORKER_PORT=3010 \
	PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
RUN pnpm --filter @geo/worker exec playwright install --with-deps chromium \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends fonts-noto-cjk \
	&& rm -rf /var/lib/apt/lists/*
CMD ["corepack", "pnpm", "--filter", "@geo/worker", "start"]
