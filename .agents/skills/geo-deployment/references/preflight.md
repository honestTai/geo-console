# Server preflight

- Confirm Linux host, Docker Engine/Compose availability, DNS, ports 80/443, disk capacity, time sync, and backup destination.
- Create `secrets/postgres_password`, `secrets/deepseek_api_key`, and `secrets/admin_password` with owner-only permissions.
- Generate the Caddy Basic Auth hash separately from the raw Worker admin password.
- Review `docker compose config` without printing secret contents.
- Build, start PostgreSQL, confirm health, then start Worker/Web/Caddy.
- Confirm HTTPS, admin authentication, Worker health, migration table, persistent volumes, and backup creation.
- Create one Collector node token, store it only on the chosen collector, then verify heartbeat and a non-sensitive session-status check.
