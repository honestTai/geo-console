---
name: geo-deployment
description: Install, deploy, upgrade, and roll back GEO Console on a local Mac or a Docker server with PostgreSQL, Caddy HTTPS, secrets, persistent evidence, and remote Collector pairing. Use for environment setup, not application feature work.
---

# GEO Deployment

Determine whether the target is local or server, then read the corresponding section of [../../../docs/deployment.md](../../../docs/deployment.md).

## Local

- Reuse Node.js 24 and Corepack when available. Install project dependencies with the lockfile and Playwright Chromium to the user's cache; do not use sudo or a global package install.
- Run `pnpm geo setup` only against the project's new PGlite directory. Confirm its resolved path before any restore.
- Bind local services to `127.0.0.1`. Keep database, artifacts, profiles, token, and keys outside the repository.

## Server

- Require a concrete domain, server target, administrator credential plan, and backup location before mutating the server.
- Expose only Caddy ports 80/443. Keep PostgreSQL and Worker internal.
- Use Docker Secrets or environment variables for keys. Never bake secrets into images, Compose YAML, logs, or Git.
- Pair each remote Collector from the platform settings with a distinct one-time revocable token. Verify that heartbeat reports the expected adapter version and capabilities; cookies remain on the Collector machine.
- Back up PostgreSQL and the evidence volume before upgrades. Validate new health checks and a Collector round trip before declaring success.
- Roll back using recorded images. If migrations are incompatible, restore a backup into a new empty database and validate before switching traffic.

Read [references/preflight.md](references/preflight.md) before a server deployment or upgrade.
