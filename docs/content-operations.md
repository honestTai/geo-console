# Content Operations

Implemented from pre-task ref `673d9796a2e41fc2e92d21d7c2dc8898dd011933`. This change uses the existing React/antd framework and independently implements a light blue operations workspace. No GEOFlow source, stylesheet, or branded asset is included.

## Scope

The follow-up layout request applies to the entire workspace. Shell uses a 256px sidebar, 64px header and 48px desktop gutters. Page renders one 30px H1; customer/page navigation lives in the header. Shared theme, lists, empty states, form controls and KPI spacing follow the supplied task-management screenshot. Remediation now uses TaskManagementLayout: active task table, completed-task foldout, four counters, and three runtime information panels. Creation/planning uses the existing approved-batch operations; task details and approvals retain their original permissions and services. No task recycle bin, bulk worker start or fabricated heartbeat is added.

Follow-up visual validation covered all 20 workspace views at 1440 and 1280 pixels with no document overflow or JavaScript exceptions. The task empty-state geometry at 1440x900 is: list x304/y186/w1088/h303, completed fold x304/y513/h84, KPI row y629/h94, runtime panels y755. Populated task and archived-project scenarios used browser-only fixtures; the detail drawer remained within the viewport and write actions stayed hidden/disabled. The isolated preview has no connected Log Service, so that page correctly shows a service-unavailable state.

Final follow-up checks: 291 tests passed, including two task-layout permission/data-state regressions; type checks, build, lint, and drift verification over the explicitly listed layout-owned files passed. No database migration or production deployment was performed for the layout follow-up.

- Article operations separate editorial review, quality review, and publication state. Search, status filters, cross-page selection, and Markdown export operate on authorized project records.
- Database migration 0028 preserves immutable article versions and quality input/attempt/review history. Text, title, summary, publication plan, evidence, and regeneration changes increment the article version. Legacy articles get a historical version, not a fabricated approval.
- Quality jobs freeze the article, evidence, approved knowledge revisions, model endpoint, and policy. The Semantic Worker has a separate single quality slot alongside measurement and answer analysis. The model has no tools. Invalid quotations, unknown references, blockers, missing evidence, or stale inputs prevent approval. Editorial review and quality review are distinct human actions.
- Customer knowledge assets are scoped to a customer and have source notes, optional source URLs and expiry, typed product/case/fact/material content, immutable revisions, and explicit approval/withdrawal/archive history. Editing returns the asset to draft. Only current, approved, unexpired revisions can support new quality checks. Authorized article-generation runs can read a bounded set of approved customer materials; these are customer-provided sources, not independent proof or measurement evidence.
- Per the user's selected scope, distribution is manual only. Channels store platform/account identity and entry links, not credentials or browser cookies. Orders bind immutable article and channel snapshots, assignee, and planned time. States are draft, ready, in_progress, submitted, verified, failed, cancelled, and outcome_unknown. The system does not publish to external platforms.
- Preparing or starting an order rechecks the current article's editorial/quality approvals, active channel, and assignee permissions. An already started historical version can receive its actual receipt after the article is edited. Verifying that receipt completes that delivery only; it cannot mark the newer article published or prove improved GEO visibility.
- Operations overview returns only sections the caller can read: review/quality/publication/knowledge/remediation tasks, published content counts, pending baseline retests after verified deliveries, and imported business metrics by source. Visits and leads are not invented when no imported data exists.

## Ownership

`article-quality.ts` and `articles.ts` own article/version gates; `customer-knowledge.ts` owns customer material governance; `publications.ts` owns manual delivery; `project-operations.ts` owns read-only overview aggregates. `content-routes.ts` is the HTTP dispatcher behind the existing authorization boundary. UI modules are Articles/ArticleQuality, CustomerKnowledge, Publications, and OperationsOverview. Theme tokens and Shell implement the light blue style.

## Permissions And Recovery

Release review additionally verifies knowledge-read authorization before a queued quality request sends customer sources to the model and within the result-selection transaction. Revocation terminates that run without selecting its output. Soft-deleted articles are excluded from new report snapshots and live workbench context; previously frozen reports retain their original article payload and hash.

Migrations 0028-0031 must be deployed with API, Web, Agent, and Semantic Worker from this change. New page/action permissions require explicit grants to existing organizations and roles; migrations do not restore revoked grants. Local development bypass remains restricted to a non-production empty-user database. Every new project table has the existing project lifecycle write guard.

Quality uses a 5-minute renewable lease and at most two technical attempts. Exhausted leases converge through queue-recovery. Inspect quality runs and attempts when a model fails; retry by creating a new run, not altering stored evidence. Publishing remains blocked while checks are unavailable or stale.

Receipt submission does not schedule network writes. Failed and unknown outcomes require an operator's explicit next action. Do not infer success from task completion, an article status, or an accessible URL alone. Receipt review records the operator's verification, while existing website remediation and frozen-config retests remain separate.

Backups include all new version, quality, material, channel, order, event, and receipt tables. Retain them during rollback. Old application versions cannot enforce these new gates, so do not run an older writer against a database with active content workflows. Raw query captures and artifacts are unchanged.

## Verification Boundaries

Final local regression on 2026-09-08: 289 tests passed; check-types, build, lint, and major-change drift verification against the pre-task ref passed. Build retains the existing large-chunk/provider-env warnings. Browser validation used a newly created local PGlite database, a clearly named UI acceptance project, and browser-only article fixtures. Checked knowledge creation/approval, channel creation, operations-to-filter navigation, long titles, and article quality drawers at 1440/1280/900 pixels with no JavaScript errors. Fixed knowledge title hit-area overlap, narrow viewport drawer clipping, and existing onboarding draft reset on unchanged polling. No external publication or paid model call was performed.

Automated tests use newly created PGlite databases and test-only model responses. Real HRouter output quality, production PostgreSQL concurrency, actual platform publication, and production deployment need separate environment validation. No external database is implicitly authorized by this change.
