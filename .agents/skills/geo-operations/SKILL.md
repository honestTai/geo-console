---
name: geo-operations
description: Operate and troubleshoot GEO Console health, cloud provider failures, capture/report leases, drift alerts, S3 evidence, backups, restores, and retention. Use for an existing instance, not first deployment or feature work.
---

# GEO Operations

Operate the named instance without weakening its evidence trail.

1. Identify local PGlite or the exact server. Do not infer a production target from environment variables.
2. Begin with read-only health, process/container, disk/object-store, database queue and provider-test checks. Read [../../../docs/operations.md](../../../docs/operations.md).
3. Treat raw captures and artifacts as immutable. Repair configuration or derived data, then create a new batch.
4. Let expired leases become claimable. Never mark unfinished capture or PDF jobs complete.
5. Group failures by provider and code. Auth, quota, timeout, model retirement, search-not-triggered and protocol changes require different remedies; never substitute another provider.
6. Keep quick audits, baselines and retests separate. A retest is comparable only to its frozen baseline.
7. Verify Report Worker, Chromium/font availability and object-store permissions for PDF incidents; do not rebuild an already valid snapshot.
8. Back up PostgreSQL and local objects together. With S3, validate versioning and object restoration alongside the DB dump.
9. Before evidence deletion, resolve exact project ID, database rows and object prefix; report backup state and obtain confirmation.

Use [references/incident-checklist.md](references/incident-checklist.md) for partial batches or stuck reports.
