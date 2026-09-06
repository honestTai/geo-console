import type { Database } from "@geo/core";

/** Exhausted leases are not claimable. Converge jobs and their dependent state even after the final crash. */
export async function sweepTerminalLeases(database: Database): Promise<number> {
	const expired = await database.query<{
		type: string;
		payload: Record<string, string>;
	}>(`UPDATE jobs SET status='failed',lease_owner=NULL,
		lease_expires_at=NULL,last_error='执行进程在最后一次尝试中中断，租约已过期',updated_at=now()
		WHERE type IN ('agent_draft','agent_session_turn','report_document','report_pdf','semantic_parse') AND status='leased'
		AND lease_expires_at<now() AND attempts>=max_attempts RETURNING type,payload`);
	for (const row of expired.rows) {
		if (row.type === "agent_draft")
			await database.query(
				"UPDATE agent_runs SET status='failed',error_message='执行租约已过期且重试耗尽',completed_at=now() WHERE id=$1 AND status IN ('queued','running')",
				[row.payload.runId],
			);
		if (row.type === "agent_session_turn")
			await database.query(
				"UPDATE agent_sessions SET status='failed',waiting=NULL,error_message='执行租约已过期且重试耗尽',updated_at=now() WHERE id=$1 AND status='running'",
				[row.payload.sessionId],
			);
	}
	return expired.affectedRows;
}
