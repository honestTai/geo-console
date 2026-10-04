import type { DatabaseSync } from "node:sqlite";
import schema from "./sqlite-schema-source.json";

/** SQLite-native data guards. These are part of empty-schema initialization, not migrations. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One empty-schema initializer keeps all immutable and authorization triggers auditable together.
export function initializeSqliteGuards(db: DatabaseSync): void {
	const trigger = (name: string, when: string, body: string) =>
		db.exec(`CREATE TRIGGER ${name} ${when} BEGIN ${body} END`);
	const changed = (table: string, except: string[]) =>
		schema.columns
			.filter((c) => c.table_name === table && !except.includes(c.column_name))
			.map((c) => `NEW."${c.column_name}" IS NOT OLD."${c.column_name}"`)
			.join(" OR ");
	for (const table of [
		"article_versions",
		"article_quality_attempts",
		"article_quality_reviews",
		"article_editorial_reviews",
		"customer_knowledge_revisions",
		"customer_knowledge_reviews",
		"publication_receipts",
		"publication_events",
	])
		for (const operation of ["UPDATE", "DELETE"])
			trigger(
				`${table}_immutable_${operation}`,
				`BEFORE ${operation} ON ${table}`,
				"SELECT RAISE(ABORT,'article_history_immutable');",
			);
	trigger(
		"article_quality_frozen_update",
		`BEFORE UPDATE ON article_quality_runs WHEN ${changed("article_quality_runs", ["status", "selected_attempt_id", "error_message", "updated_at", "completed_at"])}`,
		"SELECT RAISE(ABORT,'article_quality_input_immutable');",
	);
	trigger(
		"article_quality_frozen_delete",
		"BEFORE DELETE ON article_quality_runs",
		"SELECT RAISE(ABORT,'article_quality_input_immutable');",
	);
	trigger(
		"article_deleted",
		"BEFORE UPDATE ON optimization_articles WHEN OLD.deleted_at IS NOT NULL",
		"SELECT RAISE(ABORT,'article_deleted');",
	);
	const content = [
		"project_id",
		"organization_id",
		"title",
		"summary",
		"content_markdown",
		"publication_plan",
		"evidence_ids",
		"target_prompt_ids",
		"fact_gaps",
		"source_run_id",
	];
	trigger(
		"article_version_update",
		`AFTER UPDATE OF ${content.join(",")} ON optimization_articles WHEN ${content.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")}`,
		"UPDATE optimization_articles SET version=OLD.version+1,status='draft' WHERE id=NEW.id;",
	);
	const snapshot = `json_object('articleId',id,'projectId',project_id,'organizationId',organization_id,'version',version,'title',title,'summary',summary,'contentMarkdown',content_markdown,'publicationPlan',json(publication_plan),'evidenceIds',json(evidence_ids),'targetPromptIds',json(target_prompt_ids),'factGaps',json(fact_gaps))`;
	for (const operation of ["INSERT", "UPDATE"])
		trigger(
			`article_snapshot_${operation}`,
			`AFTER ${operation} ON optimization_articles`,
			`INSERT INTO article_versions(id,article_id,project_id,organization_id,version,snapshot) SELECT id||':'||version,id,project_id,organization_id,version,${snapshot} FROM optimization_articles WHERE id=NEW.id ON CONFLICT(article_id,version) DO NOTHING;`,
		);
	trigger(
		"user_credential_version",
		"AFTER UPDATE OF password_hash ON users WHEN NEW.password_hash IS NOT OLD.password_hash",
		"UPDATE users SET credential_version=OLD.credential_version+1 WHERE id=NEW.id;",
	);
	trigger(
		"user_authority_version",
		"AFTER UPDATE OF all_projects,disabled_at,is_super_admin,organization_id ON users WHEN NEW.all_projects IS NOT OLD.all_projects OR NEW.disabled_at IS NOT OLD.disabled_at OR NEW.is_super_admin IS NOT OLD.is_super_admin OR NEW.organization_id IS NOT OLD.organization_id",
		"UPDATE users SET authz_version=OLD.authz_version+1 WHERE id=NEW.id;",
	);
	trigger(
		"org_state_version",
		"AFTER UPDATE OF suspended_at ON organizations WHEN NEW.suspended_at IS NOT OLD.suspended_at",
		"UPDATE organizations SET authz_version=OLD.authz_version+1 WHERE id=NEW.id;",
	);
	for (const table of ["organization_permissions", "roles", "role_permissions", "user_roles", "user_project_access"]) {
		for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
			const ref = operation === "DELETE" ? "OLD" : "NEW";
			const organization =
				table === "roles" || table === "organization_permissions"
					? `${ref}.organization_id`
					: table === "role_permissions"
						? `(SELECT organization_id FROM roles WHERE id=${ref}.role_id)`
						: `(SELECT organization_id FROM users WHERE id=${ref}.user_id)`;
			trigger(
				`${table}_authz_${operation}`,
				`AFTER ${operation} ON ${table}`,
				`UPDATE organizations SET authz_version=authz_version+1 WHERE id=${organization};`,
			);
		}
	}
	for (const table of ["organization_permissions", "role_permissions"])
		for (const operation of ["INSERT", "UPDATE"])
			trigger(
				`${table}_system_permission_${operation}`,
				`BEFORE ${operation} ON ${table} WHEN EXISTS(SELECT 1 FROM permissions WHERE key=NEW.permission_key AND system_only=1)`,
				"SELECT RAISE(ABORT,'System-only permissions cannot be assigned to organizations or tenant roles');",
			);
	trigger("project_delete", "BEFORE DELETE ON projects", "SELECT RAISE(ABORT,'project_deleted');");
	trigger(
		"project_deleted_update",
		"BEFORE UPDATE ON projects WHEN OLD.deleted_at IS NOT NULL",
		"SELECT RAISE(ABORT,'project_deleted');",
	);
	trigger(
		"project_archived_update",
		`BEFORE UPDATE ON projects WHEN OLD.status='archived' AND (NEW.deleted_at IS NULL OR ${changed("projects", ["deleted_at", "updated_at"])})`,
		"SELECT RAISE(ABORT,'project_archived');",
	);
	const indirect: Record<string, string> = {
		agent_session_events: "(SELECT project_id FROM agent_sessions WHERE id=ROW.session_id)",
		desktop_agent_tool_calls: "(SELECT project_id FROM agent_sessions WHERE id=ROW.session_id)",
		report_shares: "(SELECT project_id FROM report_snapshots WHERE id=ROW.report_id)",
		semantic_observations: "(SELECT project_id FROM semantic_parse_runs WHERE id=ROW.run_id)",
		semantic_selections: "(SELECT project_id FROM semantic_parse_runs WHERE id=ROW.run_id)",
		metric_snapshots: "(SELECT project_id FROM semantic_parse_runs WHERE id=ROW.run_id)",
		answer_analysis_attempts: "(SELECT project_id FROM answer_analysis_runs WHERE id=ROW.run_id)",
		measurement_drift_observations:
			"(SELECT r.project_id FROM metric_snapshots m JOIN semantic_parse_runs r ON r.id=m.run_id WHERE m.id=ROW.metric_id)",
		jobs: "geo_job_project(ROW.payload)",
	};
	const tables = new Set([
		...schema.columns
			.filter((c) => c.column_name === "project_id" && c.table_name !== "user_project_access")
			.map((c) => c.table_name),
		...Object.keys(indirect),
	]);
	for (const table of tables)
		for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
			const checks = (operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "INSERT" ? "NEW" : "OLD"])
				.map((ref) => {
					const target = (indirect[table] ?? "ROW.project_id").replaceAll("ROW.", `${ref}.`);
					return `SELECT CASE WHEN ${target} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=${target} AND deleted_at IS NULL) THEN RAISE(ABORT,'project_deleted') WHEN EXISTS(SELECT 1 FROM projects WHERE id=${target} AND status='archived') THEN RAISE(ABORT,'project_archived') END;`;
				})
				.join("\n");
			trigger(`${table}_writable_${operation}`, `BEFORE ${operation} ON ${table}`, checks);
		}
}
