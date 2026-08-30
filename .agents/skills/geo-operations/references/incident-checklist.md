# Failed or partial batch

1. Record batch ID, frozen config hash, expected samples, valid samples, and failed samples.
2. Check `pnpm geo doctor`, Worker health, Collector status, free disk, and recent process output.
3. Group capture failures by platform and code. `login_required`, challenge, rate limit, page contract, timeout, and process/network failure require different actions.
4. Relogin only the affected platform. Page-contract failures require an adapter change and test before a new batch.
5. Do not rerun individual business failures under the same batch. Fix the condition and create a new comparable retest so the historical failure rate stays auditable.
6. When process failures leave leased jobs, stop duplicate collectors and allow lease expiry. Inspect a database write only after this recovery path fails.
