import type { Database, WebsiteAuditResult } from "@geo/core";
import { HttpInputError, parseJsonColumn } from "./utils";

/** Resolve a referenced immutable website record, including older records outside the project's recent list. */
export async function getWebsiteEvidence(database: Database, projectId: string, evidenceId: string) {
	const audit = (
		await database.query<{ id: string; checked_at: string; result: WebsiteAuditResult | string }>(
			"SELECT id,checked_at,result FROM website_audits WHERE project_id=$1 AND id=$2",
			[projectId, evidenceId],
		)
	).rows[0];
	if (audit)
		return { kind: "audit" as const, audit: { ...audit, result: parseJsonColumn<WebsiteAuditResult>(audit.result) } };
	const snapshot = (
		await database.query<Record<string, unknown>>(
			"SELECT id,url,title,content_text,structured_data,content_hash,artifact_key,fetched_at FROM website_snapshots WHERE project_id=$1 AND id=$2",
			[projectId, evidenceId],
		)
	).rows[0];
	if (snapshot) return { kind: "snapshot" as const, snapshot };
	throw new HttpInputError("该客户下没有这条官网证据", 404);
}
