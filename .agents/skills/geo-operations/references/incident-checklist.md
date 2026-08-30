# Incident checklist

1. Record project, batch/report ID, config or payload hash, planned/effective samples, provider and first failure time.
2. Check API, Capture Worker, Report Worker, PostgreSQL and object-store health plus recent logs.
3. Inspect lease owner, expiry, attempts and `last_error`; stop duplicate processes and allow lease expiry before any write.
4. For captures, classify auth, rate limit, timeout, model unavailable, protocol change, missing source or no answer.
5. Fix credentials/quota/network or ship a tested adapter version. Preserve the failed batch and create a new valid baseline/retest.
6. For PDF, reuse the immutable report snapshot and retry only the report job after Chromium/font/storage recovery.
7. Confirm drift alert evidence IDs and data coverage before escalation; acknowledgement never deletes the alert.
8. Exceptional database writes require an exact target, current backup, explicit authorization and an audit note.
