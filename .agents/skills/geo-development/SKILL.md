---
name: geo-development
description: Develop and review GEO Console cloud search providers, evidence contracts, metrics, Pi Agent tools, reports, website analysis, remediation, migrations, and tests. Use for application feature work, not runtime operations or deployment-only changes.
---

# GEO Development

Read [../../../docs/architecture.md](../../../docs/architecture.md) before cross-module work and [../../../docs/search-provider-adapters.md](../../../docs/search-provider-adapters.md) before provider changes.

- Keep runtime generic across industries. Fixtures may use clearly test-only names, but no fixture, answer, metric or company may reach the UI or default database.
- Preserve the dependency direction: Web calls API; API schedules work; Capture and Report Workers own execution; packages define contracts and deterministic logic.
- Add a numbered forward SQL migration with every database contract change and update the Drizzle schema. Never edit an already deployed migration.
- Treat `query_captures`, raw response objects, website snapshots and report snapshots as append-only evidence.
- New captures use `geo.query-capture.v2` and `llm_search_api`. Historical v1 consumer evidence stays read-only and must not mix with v2 trends.
- Retests copy the formal baseline config exactly. Any model, provider, search strategy, prompt, Persona, region, repeat, window or adapter change requires a new baseline.
- Failed platforms do not enter brand-rate denominators. Source/Fan-out `unavailable` is not zero. Keep brand matching, position, citations and aggregation deterministic.
- Provider failures are persisted states. Never replace a failed provider with another model.
- Pi tools may only read current-project domain data and create drafts. Do not add Bash, arbitrary filesystem, arbitrary SQL or open HTTP. Validate every evidence, prompt and task ID again at approval.
- Webpage gaps require saved customer and comparison evidence. Crawl failure means evidence insufficient.
- Only approved Agent output can create findings/tasks/content or enter an immutable report snapshot.
- Keep API-vs-App disclosure visible, especially `yuanbao_hunyuan` as “元宝搜索源 + 混元合成”.
- Use `corepack pnpm` and preserve supply-chain controls.

Before handoff follow [references/change-checklist.md](references/change-checklist.md).
