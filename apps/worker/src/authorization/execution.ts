import type { ExecutionActor } from "@geo/authorization";
import type { Database } from "@geo/core";
import { z } from "zod";
import { AccessDeniedError, authorizeAction } from "./index";

const actorSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("user"), userId: z.string().min(1) }),
	z.strictObject({ kind: z.literal("service"), serviceId: z.literal("report-scheduler") }),
	z.strictObject({ kind: z.literal("local") }),
	z.strictObject({ kind: z.literal("unassigned") }),
]);
export function parseActor(value: unknown): ExecutionActor {
	let input = value;
	try {
		if (typeof value === "string") input = JSON.parse(value);
	} catch {
		return { kind: "unassigned" };
	}
	const parsed = actorSchema.safeParse(input);
	return parsed.success ? parsed.data : { kind: "unassigned" };
}
export async function boundExecutionActor(
	database: Database,
	input: { projectId: string; actor?: ExecutionActor; sessionId?: string | null },
): Promise<ExecutionActor> {
	if (input.sessionId) {
		const session = (
			await database.query<{ execution_actor: unknown }>(
				"SELECT execution_actor FROM agent_sessions WHERE id=$1 AND project_id=$2 AND cancelled_at IS NULL",
				[input.sessionId, input.projectId],
			)
		).rows[0];
		if (!session) throw new AccessDeniedError("执行会话不存在、已取消或不属于当前项目");
		return parseActor(session.execution_actor);
	}
	return input.actor ?? { kind: "unassigned" };
}
export async function authorizeWorkbench(database: Database, sessionId: string) {
	const session = (
		await database.query<{
			organization_id: string;
			project_id: string;
			created_by: string | null;
			execution_actor: unknown;
			cancelled_at: string | null;
		}>("SELECT organization_id,project_id,created_by,execution_actor,cancelled_at FROM agent_sessions WHERE id=$1", [
			sessionId,
		])
	).rows[0];
	if (!session || session.cancelled_at) throw new AccessDeniedError("工作台会话已取消或不存在");
	await authorizeAction(database, parseActor(session.execution_actor), "workbench.execute", {
		organizationId: session.organization_id,
		projectId: session.project_id,
		ownerUserId: session.created_by,
	});
	return session;
}
export async function authorizeDraftExecution(database: Database, runId: string) {
	const run = (
		await database.query<{
			organization_id: string;
			project_id: string;
			purpose: string;
			session_id: string | null;
			execution_actor: unknown;
		}>("SELECT organization_id,project_id,purpose,session_id,execution_actor FROM agent_runs WHERE id=$1", [runId])
	).rows[0];
	if (!run) throw new AccessDeniedError("Agent 运行不存在");
	if (run.session_id) {
		const session = await authorizeWorkbench(database, run.session_id);
		if (JSON.stringify(parseActor(session.execution_actor)) !== JSON.stringify(parseActor(run.execution_actor)))
			throw new AccessDeniedError("草稿与会话的执行身份不一致");
	}

	await authorizeAction(database, parseActor(run.execution_actor), `agent.draft.${run.purpose}`, {
		organizationId: run.organization_id,
		projectId: run.project_id,
	});
	return run;
}

export async function authorizeWorkbenchTool(database: Database, sessionId: string, tool: string) {
	const session = await authorizeWorkbench(database, sessionId);
	await authorizeAction(database, parseActor(session.execution_actor), `workbench.tool.${tool}`, {
		organizationId: session.organization_id,
		projectId: session.project_id,
		ownerUserId: session.created_by,
	});
	return session;
}
