import type { Database } from "@geo/core";

/** Batch-local circuit breaker. Never edits evidence, the frozen config, or an active lease. */
export async function settleBlockedCaptureJobs(database: Database, batchId?: string): Promise<string[]> {
	const rows = await database.query<{ batch_id: string }>(
		`UPDATE jobs j SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
		 last_error='供应商余额或额度不足：本批次该平台尚未执行的采样已停止。充值后请手动新建同条件批次；已有证据保留。',updated_at=now()
		 WHERE j.type='capture' AND (j.status='pending' OR (j.status='leased' AND j.lease_expires_at<now()))
		 AND ($1::text IS NULL OR j.payload->>'batchId'=$1)
		 AND EXISTS (SELECT 1 FROM query_captures c
		   WHERE c.batch_id=j.payload->>'batchId' AND c.platform=j.payload->>'platform'
		   AND (c.failure_code='quota_exceeded' OR (c.failure_code='provider_error' AND c.failure_message ~ 'HTTP 402([^0-9]|$)')))
		 RETURNING j.payload->>'batchId' AS batch_id`,
		[batchId ?? null],
	);
	return [...new Set(rows.rows.map((row) => row.batch_id))];
}

export async function captureProgress(database: Database, batchId: string) {
	const progress = (
		await database.query<{
			pending: number;
			active: number;
			completed: number;
			failed: number;
			next_at: string | null;
		}>(
			`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,
	 count(*) FILTER(WHERE status='leased')::int AS active,
	 count(*) FILTER(WHERE status='complete')::int AS completed,
	 count(*) FILTER(WHERE status='failed')::int AS failed,
	 min(available_at) FILTER(WHERE status='pending') AS next_at
	 FROM jobs WHERE type='capture' AND payload->>'batchId'=$1`,
			[batchId],
		)
	).rows[0];
	const blocked = await database.query<{ platform: string }>(
		`SELECT DISTINCT platform FROM query_captures WHERE batch_id=$1 AND
		 (failure_code='quota_exceeded' OR (failure_code='provider_error' AND failure_message ~ 'HTTP 402([^0-9]|$)'))`,
		[batchId],
	);
	return { ...progress, blockedProviders: blocked.rows.map((row) => row.platform) };
}
