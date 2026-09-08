import type { ExecutionActor } from "@geo/authorization";
import type { Database } from "@geo/core";
import { z } from "zod";
import { authorizeRequest, loadActorPrincipal } from "./authorization";
import { HttpInputError } from "./utils";

const confirmationSchema = z.object({ confirmName: z.string().min(1), confirmed: z.literal(true) });

export async function changeProjectLifecycle(
	database: Database,
	projectId: string,
	operation: "archive" | "delete",
	input: unknown,
	actor: ExecutionActor,
) {
	const data = confirmationSchema.parse(input);
	return database.transaction(async (tx) => {
		const project = (
			await tx.query<{ id: string; name: string; organization_id: string; status: string; deleted_at: string | null }>(
				"SELECT id,name,organization_id,status,deleted_at FROM projects WHERE id=$1 FOR UPDATE",
				[projectId],
			)
		).rows[0];
		if (!project || project.deleted_at) throw new HttpInputError("客户项目不存在", 404);
		await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [project.organization_id]);
		if (actor.kind === "user") await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [actor.userId]);
		const principal = await loadActorPrincipal(tx, actor, project.organization_id);
		if (!principal) throw new HttpInputError("登录已失效，请重新登录", 401);
		await authorizeRequest(
			tx,
			principal,
			operation === "archive" ? "POST" : "DELETE",
			`/api/projects/${encodeURIComponent(projectId)}${operation === "archive" ? "/archive" : ""}`,
		);
		if (data.confirmName !== project.name) throw new HttpInputError("客户名称不一致，请核对后重新确认", 400);
		const busy = (
			await tx.query(
				`SELECT 1 WHERE
			 EXISTS(SELECT 1 FROM jobs WHERE status IN ('pending','leased') AND geo_job_project(payload)=$1)
			 OR EXISTS(SELECT 1 FROM agent_runs WHERE project_id=$1 AND status IN ('queued','running'))
			 OR EXISTS(SELECT 1 FROM semantic_parse_runs WHERE project_id=$1 AND status IN ('queued','running'))
			 OR EXISTS(SELECT 1 FROM answer_analysis_runs WHERE project_id=$1 AND status IN ('queued','running'))
			 OR EXISTS(SELECT 1 FROM agent_sessions WHERE project_id=$1 AND status IN ('running','waiting_job') AND cancelled_at IS NULL)`,
				[projectId],
			)
		).rows[0];
		if (busy) throw new HttpInputError("该客户还有未结束的任务，请等待完成或在工作台停止任务后再操作", 409);
		if (project.status !== "archived") {
			await tx.query("UPDATE monitoring_schedules SET enabled=false,updated_at=now() WHERE project_id=$1", [projectId]);
		}
		await tx.query(
			operation === "archive"
				? "UPDATE projects SET status='archived',archived_at=now(),updated_at=now() WHERE id=$1"
				: "UPDATE projects SET deleted_at=now(),updated_at=now() WHERE id=$1",
			[projectId],
		);
		return { id: projectId, archived: operation === "archive", deleted: operation === "delete" };
	});
}
