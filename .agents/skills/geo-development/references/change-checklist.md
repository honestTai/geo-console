# Change checklist

## Data and queues

- Run migrations only on a new project PGlite or explicitly isolated PostgreSQL.
- Test lease expiry, append-only evidence, batch comparability and nullable cost/source semantics when affected.
- Keep API, Capture Worker and Report Worker independently restartable.

## Provider adapter

- Cover success, no source, search not triggered, auth, rate limit, timeout, model unavailable and protocol changed.
- Persist raw response, model, protocol, search tool version, Request ID, usage, latency and failure.
- Increase adapter/search version when interpretation changes.

## Agent and report

- Test prompt-injection treatment, cross-project IDs, tool whitelist, schema rejection, approval and failure recovery.
- Verify report type rules, snapshot hash, PDF queue, Chinese font, evidence appendix, sharing expiry/revoke and Yuanbao disclosure.

## UI and final gates

- Verify empty/loading/error/partial/read-only states without fabricated data.
- Check desktop and 390px mobile layouts; no overlap or clipped controls.
- Run `corepack pnpm check-types`, `test`, `build`, `lint`, `license-check` and relevant Docker checks.
