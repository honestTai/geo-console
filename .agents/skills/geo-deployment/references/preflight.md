# Server preflight

- Confirm Linux, Docker Engine/Compose, DNS, ports 80/443, 4 vCPU/8 GB baseline, disk, time sync and backup destination.
- Create owner-only `secrets/postgres_password`, `secrets/master_key` and `secrets/admin_password`; keep an offline copy of the master key.
- Check `.env` domain, admin email, capture concurrency and object-store settings without printing secrets.
- For S3, verify private bucket access, versioning, encryption, lifecycle and recovery ownership.
- Run `docker compose config --quiet`, build images, then start PostgreSQL, API, Capture Worker, Report Worker, Web and Caddy.
- Verify HTTPS, app login, `/api/health`, migration table, worker logs, object write/read, one provider test and PDF generation.
- Run the backup profile and prove the dump can be listed before declaring deployment complete.
