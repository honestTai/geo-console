import type { AgentJobPayload, AgentSessionTurnPayload, Database } from "@geo/core";
import { safeErrorMessage } from "@geo/logging";
import { agentRuntimeLogger, executeAgentDraft } from "./agent";
import { parseJsonColumn } from "./utils";
import { executeSessionTurn, recoverOrphanedSessions, resumeWaitingSessions, workbenchLogger } from "./workbench";

type AgentJob = {
	id: string;
	type: "agent_draft" | "agent_session_turn";
	payload: AgentJobPayload | AgentSessionTurnPayload | string;
	attempts: number;
	max_attempts: number;
};

export { executeAgentDraft, executeSessionTurn };

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
	const sessions = await recoverOrphanedSessions(database);
	return result.affectedRows + sessions;
}

export type AgentJobRunners = {
	draft?: (database: Database, runId: string, targetTaskId: string | null) => Promise<void>;
	sessionTurn?: (
		database: Database,
		sessionId: string,
		trigger: AgentSessionTurnPayload["trigger"],
		message: string | null,
	) => Promise<void>;
};

/** 周期性协调：自动批准工作台草稿、唤醒等待中的会话。失败不影响任务领取。 */
export async function coordinateWorkbench(database: Database): Promise<void> {
	try {
		await resumeWaitingSessions(database);
	} catch (error) {
		workbenchLogger.error("workbench.coordinate_failed", safeErrorMessage(error));
	}
}

export async function runOneAgentJob(
	database: Database,
	owner: string,
	runner:
		| ((database: Database, runId: string, targetTaskId: string | null) => Promise<void>)
		| AgentJobRunners = executeAgentDraft,
): Promise<boolean> {
	const runners: AgentJobRunners = typeof runner === "function" ? { draft: runner } : runner;
	const runDraft = runners.draft ?? executeAgentDraft;
	const runTurn = runners.sessionTurn ?? executeSessionTurn;
	const job = await database.transaction(async (transaction) => {
		const result = await transaction.query<AgentJob>(
			`WITH candidate AS (
				SELECT id FROM jobs WHERE type IN ('agent_draft','agent_session_turn') AND attempts<max_attempts
				 AND available_at<=now() AND (status='pending' OR (status='leased' AND lease_expires_at<now()))
				 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
			) UPDATE jobs SET status='leased',lease_owner=$1,lease_expires_at=now()+interval '15 minutes',
			 attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM candidate)
			 RETURNING id,type,payload,attempts,max_attempts`,
			[owner],
		);
		return result.rows[0] ?? null;
	});
	if (!job) return false;
	const payload = parseJsonColumn<AgentJobPayload | AgentSessionTurnPayload>(job.payload);
	const traceId = "runId" in payload ? payload.runId : payload.sessionId;
	const leaseTimer = setInterval(() => {
		void database
			.query(
				"UPDATE jobs SET lease_expires_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased'",
				[job.id, owner],
			)
			.catch((error) =>
				agentRuntimeLogger.error("agent.lease_renewal_failed", safeErrorMessage(error), {
					traceId,
					metadata: { jobId: job.id },
				}),
			);
	}, 60_000);
	try {
		if (job.type === "agent_session_turn") {
			const turn = payload as AgentSessionTurnPayload;
			await runTurn(database, turn.sessionId, turn.trigger, turn.message);
		} else {
			const draft = payload as AgentJobPayload;
			await runDraft(database, draft.runId, draft.targetTaskId);
		}
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
			if (job.type === "agent_session_turn") {
				const turn = payload as AgentSessionTurnPayload;
				if (retrying)
					await transaction.query(
						"UPDATE agent_sessions SET status='running',error_message=$2,updated_at=now() WHERE id=$1",
						[turn.sessionId, `第 ${job.attempts} 次执行失败，30 秒后自动重试：${message}`],
					);
				else
					await transaction.query(
						"UPDATE agent_sessions SET status='failed',waiting=NULL,error_message=$2,updated_at=now() WHERE id=$1",
						[turn.sessionId, message],
					);
				return;
			}
			const draft = payload as AgentJobPayload;
			if (retrying)
				await transaction.query(
					"UPDATE agent_runs SET status='queued',error_message=$2,completed_at=NULL WHERE id=$1",
					[draft.runId, `第 ${job.attempts} 次执行失败，30 秒后自动重试：${message}`],
				);
			else
				await transaction.query(
					"UPDATE agent_runs SET status='failed',error_message=$2,completed_at=now() WHERE id=$1",
					[draft.runId, message],
				);
		});
	} finally {
		clearInterval(leaseTimer);
	}
	return true;
}
