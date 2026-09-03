import { randomUUID } from "node:crypto";
import type { Database } from "./database";
import type { CaptureJobPayload } from "./schema";

export async function enqueueCaptureJob(
	database: Database,
	payload: CaptureJobPayload,
	availableAt?: Date,
): Promise<string> {
	const id = randomUUID();
	await database.query(
		`INSERT INTO jobs (id, type, payload, status, available_at, created_at, updated_at)
		 VALUES ($1, 'capture', $2::jsonb, 'pending', COALESCE($3::timestamptz,now()), now(), now())`,
		[id, JSON.stringify(payload), availableAt?.toISOString() ?? null],
	);
	return id;
}

export type LeasedJob = { id: string; payload: CaptureJobPayload; attempts: number; leaseExpiresAt: string };

export async function claimCaptureJob(
	database: Database,
	owner: string,
	leaseSeconds = 180,
	platforms?: string[],
): Promise<LeasedJob | null> {
	return database.transaction(async (transaction) => {
		// Expired leases are claimable so a worker crash cannot strand a batch permanently.
		const result = await transaction.query<{
			id: string;
			payload: CaptureJobPayload;
			attempts: number;
			lease_expires_at: string;
		}>(
			`WITH candidate AS (
				SELECT id FROM jobs
				WHERE type = 'capture'
				  AND attempts < max_attempts
				  AND available_at <= now()
				  AND ($3::text[] IS NULL OR payload->>'platform' = ANY($3::text[]))
				  AND (status = 'pending' OR (status = 'leased' AND lease_expires_at < now()))
				ORDER BY created_at
				LIMIT 1
				FOR UPDATE SKIP LOCKED
			)
			UPDATE jobs
			SET status = 'leased', lease_owner = $1,
				lease_expires_at = now() + ($2 * interval '1 second'), attempts = attempts + 1, updated_at = now()
			WHERE id = (SELECT id FROM candidate)
			RETURNING id, payload, attempts, lease_expires_at`,
			[owner, leaseSeconds, platforms ?? null],
		);
		const row = result.rows[0];
		return row
			? { id: row.id, payload: row.payload, attempts: row.attempts, leaseExpiresAt: row.lease_expires_at }
			: null;
	});
}

export async function renewJobLease(
	database: Database,
	jobId: string,
	owner: string,
	leaseSeconds = 180,
): Promise<boolean> {
	const result = await database.query(
		`UPDATE jobs SET lease_expires_at = now() + ($3 * interval '1 second'), updated_at = now()
		 WHERE id = $1 AND lease_owner = $2 AND status = 'leased'`,
		[jobId, owner, leaseSeconds],
	);
	return result.affectedRows === 1;
}

export async function failJob(database: Database, jobId: string, owner: string, message: string): Promise<void> {
	await database.query(
		`UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'pending'::job_status END,
		 lease_owner = NULL, lease_expires_at = NULL, last_error = $3,
		 available_at = now() + interval '30 seconds', updated_at = now()
		 WHERE id = $1 AND lease_owner = $2`,
		[jobId, owner, message.slice(0, 2000)],
	);
}

/**
 * 租约已过期且重试次数用尽的 capture 任务不会再被任何 Worker 领取（claim 要求 attempts < max_attempts），
 * 若执行进程在 failJob 之前崩溃，它会永久停在 leased 并让批次卡在“采集中”。
 * 这里把这类任务标为 failed 并返回受影响批次，由调用方刷新批次状态。
 */
export async function failExpiredCaptureJobs(database: Database): Promise<string[]> {
	const result = await database.query<{ batch_id: string | null }>(
		`UPDATE jobs SET status = 'failed'::job_status, lease_owner = NULL, lease_expires_at = NULL,
		 last_error = COALESCE(last_error, '执行进程中断：租约过期且已达最大重试次数'), updated_at = now()
		 WHERE type = 'capture' AND status = 'leased' AND lease_expires_at < now() AND attempts >= max_attempts
		 RETURNING payload->>'batchId' AS batch_id`,
	);
	return [...new Set(result.rows.flatMap((row) => (row.batch_id ? [row.batch_id] : [])))];
}
