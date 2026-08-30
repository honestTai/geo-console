# Change gates

## Database contract

- Update Drizzle schema and add a new numbered SQL migration.
- Test the migration against a new empty in-memory/file PGlite database.
- Test PostgreSQL only when an isolated test instance is available and authorized; never substitute an existing external database.
- Cover job lease expiry, evidence uniqueness, and batch comparability when those contracts change.

## Consumer-surface adapter

- Keep DOM selectors in Collector adapter code.
- Test login missing, challenge, rate limit, no answer, timeout, missing sources, and page-contract changes.
- Verify each question starts a new conversation and concurrency remains one per platform account.
- Perform a live capture only with the user's account and approval; never commit the question, answer, screenshot, cookies, or test project.

## UI workflow

- Verify empty state and actual API error state; do not fabricate success data.
- Check desktop and 390px mobile widths for text fit, overflow, disabled controls, and print report output.
