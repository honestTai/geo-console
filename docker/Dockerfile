ARG GEO_WORKER_BASE_IMAGE=geo-console-worker-base:node24-playwright1234
FROM ${GEO_WORKER_BASE_IMAGE} AS worker
WORKDIR /opt/geo-app
ADD server-runtime.tar /
ENV NODE_ENV=production GEO_WORKER_HOST=0.0.0.0 GEO_WORKER_PORT=3010
CMD ["/opt/geo-app/apps/worker/node_modules/.bin/tsx", "/opt/geo-app/apps/worker/src/index.ts"]

FROM caddy:2.10.2-alpine AS web
COPY apps/web/dist /srv/app
COPY landing /srv
COPY docker/caddy/Web.Caddyfile /etc/caddy/Caddyfile
