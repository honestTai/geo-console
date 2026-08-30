# GEO Console Codex Routing

This repository is a Node.js 24, pnpm 11, TypeScript monorepo. Use only `corepack pnpm`; preserve the supply-chain controls in `pnpm-workspace.yaml`. Never add runtime mock answers, companies, metrics, or industry-specific defaults.

Use the project skills under `.agents/skills/` as follows:

- For health checks, capture/report queue recovery, provider failures, backups, restores, or evidence retention, use `geo-operations`.
- For code changes, database contracts, metrics, cloud search adapters, Pi Agent tools, reports, migrations, or tests, use `geo-development`.
- For local installation, server Docker, HTTPS, S3-compatible storage, secrets, upgrades, or rollback, use `geo-deployment`.

Only run migrations against a newly created project PGlite database or an explicitly supplied test/deployment PostgreSQL database. Never infer authority to connect to or mutate an existing external database.

Raw rows in `query_captures` and their artifacts are evidence. Do not update or delete them as a normal repair. Reparse into derived data or create a new batch. Retests must reuse the baseline `config` exactly.

Before handoff run `corepack pnpm check-types`, `corepack pnpm test`, `corepack pnpm build`, and `corepack pnpm lint`. Use `apply_patch` for manual edits.
