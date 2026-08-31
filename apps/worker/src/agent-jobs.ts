import type { AgentJobPayload, Database } from "@geo/core";
import { executeAgentDraft } from "./agent";
import { parseJsonColumn } from "./utils";

type AgentJob = {
	id: string;
	payload: AgentJobPayload | string;
	attempts: number;
	max_attempts: number;
};

export { executeAgentDraft };

export async function recoverOrphanedAgentRuns(database: Database): Promise<number> {
	const result = await database.query(
		`UPDATE agent_runs r SET status='failed',completed_at=now(),
		 error_message='Agent 执行进程已中断；请重新运行任务'
		 WHERE r.status='running' AND r.created_at<now()-interval '15 minutes'
		 AND NOT EXISTS (
			 SELECT 1 FROM jobs j WHERE j.type='agent_draft' AND j.payload->>'runId'=r.id
			 AND j.status IN ('pending','leased')
		 )`,
	);
	return result.affectedRows;
}

export async function runOneAgentJob(
	database: Database,
	owner: string,
	runner: (database: Database, runId: string, targetTaskId: string | null) => Promise<void> = executeAgentDraft,
): Promise<boolean> {
	const job = await database.transaction(async (transaction) => {
		const result = await transaction.query<AgentJob>(
			`WITH candidate AS (
				SELECT id FROM jobs WHERE type='agent_draft' AND attempts<max_attempts
				 AND available_at<=now() AND (status='pending' OR (status='leased' AND lease_expires_at<now()))
				 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
			) UPDATE jobs SET status='leased',lease_owner=$1,lease_expires_at=now()+interval '15 minutes',
			 attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM candidate)
			 RETURNING id,payload,attempts,max_attempts`,
			[owner],
		);
		return result.rows[0] ?? null;
	});
	if (!job) return false;
	const payload = parseJsonColumn<AgentJobPayload>(job.payload);
	const leaseTimer = setInterval(() => {
		void database
			.query(
				"UPDATE jobs SET lease_expires_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased'",
				[job.id, owner],
			)
			.catch((error) => console.error("Agent 任务租约续期失败", job.id, error));
	}, 60_000);
	try {
		await runner(database, payload.runId, payload.targetTaskId);
		await database.query(
			"UPDATE jobs SET status='complete',lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2",
			[job.id, owner],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 2000) : "Agent 执行失败";
		const retrying = job.attempts < job.max_attempts;
		await database.transaction(async (transaction) => {
			await transaction.query(
				`UPDATE jobs SET status=$3::job_status,lease_owner=NULL,lease_expires_at=NULL,last_error=$4,
				 available_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND lease_owner=$2`,
				[job.id, owner, retrying ? "pending" : "failed", message],
			);
			if (retrying)
				await transaction.query(
					"UPDATE agent_runs SET status='queued',error_message=$2,completed_at=NULL WHERE id=$1",
					[payload.runId, `第 ${job.attempts} 次执行失败，30 秒后自动重试：${message}`],
				);
			else
				await transaction.query(
					"UPDATE agent_runs SET status='failed',error_message=$2,completed_at=now() WHERE id=$1",
					[payload.runId, message],
				);
		});
	} finally {
		clearInterval(leaseTimer);
	}
	return true;
}
