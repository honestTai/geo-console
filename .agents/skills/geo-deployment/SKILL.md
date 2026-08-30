---
name: geo-deployment
description: Install, deploy, upgrade, and roll back GEO Console locally or with Docker, PostgreSQL, Caddy HTTPS, S3-compatible evidence storage, secrets, and separate Capture/Report Workers. Use for environment setup, not feature development.
---

# GEO Deployment

Determine whether the target is the local development instance or a named server. Read [../../../docs/deployment.md](../../../docs/deployment.md) and, for servers, [references/preflight.md](references/preflight.md).

## Local

- Reuse Node.js 24 and Corepack. Use the lockfile; avoid sudo and global installs.
- Resolve `GEO_DATA_DIR` before setup or restore. Run migrations only against the new project PGlite directory.
- Bind Web/API to `127.0.0.1`. Install Playwright Chromium only for the Report Worker.
- Keep database, evidence and the macOS-keychain master key outside Git.

## Server

- Require the exact host, domain, administrator email, secret plan, object-store mode and backup destination before mutation.
- Expose only Caddy 80/443. Keep API, Capture Worker, Report Worker and PostgreSQL internal.
- Store PostgreSQL password, 32-byte Base64 master key and bootstrap password in Docker Secrets. A KMS agent may mount the master key file.
- Use a private versioned and encrypted S3-compatible bucket, or a persistent local evidence volume. All three backend services need identical object-store configuration.
- Never put provider/HRouter keys in images or Compose. Configure them through the authenticated UI so they are envelope encrypted.
- Back up PostgreSQL and local evidence together before upgrade. S3 mode additionally verifies object versions and retention.
- Roll back images only when migrations are compatible. Otherwise restore into a new empty PostgreSQL and validate before switching.

Do not deploy browser login profiles, Collector nodes or page adapters; they are not part of the cloud architecture.
