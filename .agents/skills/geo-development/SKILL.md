---
name: geo-development
description: Develop and review GEO Console business logic, database contracts, metrics, website analysis, remediation workflow, and DeepSeek/Kimi consumer-surface adapters. Use for code changes and tests, not runtime operations or deployment-only work.
---

# GEO Development

Read [../../../docs/architecture.md](../../../docs/architecture.md) before cross-module changes and [../../../docs/collector-adapters.md](../../../docs/collector-adapters.md) before adapter work.

- Keep runtime generic across industries. Test fixtures may use obviously non-production names, but no fixture or seed may appear in the user interface or default database.
- Preserve the dependency direction: Web calls Worker; Worker owns business decisions; Collector owns browser state; shared packages define contracts and deterministic metrics.
- Make evidence additions append-only. Schema changes require a forward SQL migration and matching Drizzle schema. Never edit an applied migration.
- Retest comparison requires identical frozen config. A feature that edits prompts, platforms, region, repeats, competitors, or collector version must force a new baseline or preserve the old frozen values.
- Current prompt and competitor scope is versioned with `archived_at`: create new row IDs on edit and keep old rows for historic captures. Do not revive uniqueness constraints across archived competitor versions.
- Analysis and diagnosis may use DeepSeek, but deterministic brand matching and metrics must remain ordinary code. Diagnosis output must cite existing evidence IDs and reject unknown IDs.
- A webpage coverage gap requires at least one saved customer page plus the compared competitor or citation evidence. Failure to crawl the customer site means “evidence insufficient,” not “content absent.” Persist the affected `target_prompt_ids` so remediation does not infer problem links from prose.
- Adapter failures are product data, not exceptions to hide. Never call an API model to replace a failed consumer-surface capture.
- Query Fan-out is optional observed evidence: extract only visible platform search/tool text and keep an empty array when absent. Change `currentCollectorVersion` whenever extraction semantics change so old and new batches are not treated as comparable.
- Attribution CSV imports are immutable and content-hash deduplicated. Keep business events beside AI metrics and never add causal claims automatically.
- Use `corepack pnpm` only and preserve `pnpm-workspace.yaml` supply-chain controls.

Before handoff run type checks, unit tests, build, lint, and relevant browser viewport checks. Read [references/change-checklist.md](references/change-checklist.md) for migration and adapter-specific gates.
