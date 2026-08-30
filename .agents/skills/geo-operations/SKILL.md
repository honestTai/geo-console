---
name: geo-operations
description: Operate and troubleshoot GEO Console instances, including health checks, database job leases, DeepSeek/Kimi browser sessions, backups, restores, and evidence retention. Use for runtime incidents and maintenance, not feature development or first-time deployment.
---

# GEO Operations

Operate the existing instance without weakening its evidence trail.

1. Establish whether the target is the local PGlite instance or a named server deployment. Do not infer a production target from a URL or environment variable.
2. Start with read-only health, process, disk, queue, and platform-session checks. Read [../../../docs/operations.md](../../../docs/operations.md) for commands and state meanings.
3. Treat `query_captures` and referenced artifacts as immutable evidence. Repair derived records or create a new batch; do not rewrite a raw answer.
4. Let expired leases become claimable. Never mark an unfinished job complete. Database writes for exceptional recovery require an identified job/batch, a current backup, and explicit authorization.
5. For `login_required`, open the platform's dedicated local profile for manual login. For `challenge_required`, hand control to the user. Never bypass verification or upload cookies.
6. Use the Collector node list to check heartbeat, adapter version, capabilities, and revocation before diagnosing an empty queue. Revoking a node immediately invalidates its token; confirm it has no active lease and issue a replacement token first when continuity matters.
7. Back up database and artifacts together. Browser profiles contain login state and are not part of evidence export.
8. Before deleting customer evidence, resolve the exact project ID and artifact directory, report the backup state, and request confirmation immediately before deletion.

Read [references/incident-checklist.md](references/incident-checklist.md) when handling a failed or partial batch.
