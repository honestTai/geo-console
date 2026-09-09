#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
command -v docker >/dev/null || { printf 'Docker is required.\n' >&2; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
action="${1:-start}"
case "$action" in start|stop|restart|status|logs) ;; *) printf 'Usage: bash docker/quickstart/start.sh [start|stop|restart|status|logs]\n'; exit 1;; esac
if [[ ! -f .quickstart/config.env ]]; then
  [[ "$action" == start ]] || { printf 'Run start first.\n'; exit 1; }
  read -r -p 'Administrator email: ' admin
  [[ "$admin" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { printf 'Invalid email\n'; exit 1; }
  mkdir -p .quickstart/secrets
  docker run --rm -v "$ROOT/.quickstart/secrets:/secrets" node:24.16.0-bookworm-slim node -e 'const fs=require("node:fs"),c=require("node:crypto");for(const name of ["postgres_password","master_key","log_service_token","admin_password"]){const p="/secrets/"+name;if(!fs.existsSync(p))fs.writeFileSync(p,c.randomBytes(32).toString(name==="master_key"?"base64":"base64url"),{mode:0o600,flag:"wx"});}'
  printf 'GEO_ADMIN_EMAIL=%s\nGEO_BIND=127.0.0.1\nGEO_HTTP_PORT=8080\nGEO_HTTPS_PORT=8443\nGEO_SITE_ADDRESS=http://localhost\nGEO_ORIGIN=http://localhost:8080\n' "$admin" > .quickstart/config.env
fi
for secret in postgres_password master_key log_service_token admin_password; do
  [[ -s ".quickstart/secrets/$secret" ]] || { printf 'Missing secret %s; restore your backup, do not regenerate it.\n' "$secret" >&2; exit 1; }
done
dc() { docker compose --env-file .quickstart/config.env -f docker/quickstart/compose.yaml "$@"; }
case "$action" in
  start) dc config --quiet; dc build api web; dc up -d --wait --wait-timeout 180; printf 'Ready: http://localhost:8080/app/\nAdmin password: .quickstart/secrets/admin_password\nKeep .quickstart/ and Docker volumes for future starts.\n';;
  stop) dc stop;;
  restart) dc restart;;
  status) dc ps;;
  logs) dc logs --tail 100;;
esac
