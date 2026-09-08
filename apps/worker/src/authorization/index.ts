import { type Decision, decide, type ExecutionActor, type Principal, type Resource } from "@geo/authorization";
import type { Database } from "@geo/core";
import { assertProjectAccess } from "../project-state";
import { HttpInputError } from "../utils";
import { findHttpPolicy, findPolicy } from "./policies";
import { actorFromIdentity, loadActorPrincipal } from "./principal";
import { resolveArtifact, resolveResource } from "./resources";

export const decisionMessages: Record<string, string> = {
	unauthenticated: "授权身份不存在",
	disabled_subject: "账号已停用",
	suspended_organization: "机构已封禁",
	unknown_policy: "接口或动作尚未登记授权策略",
	disabled_policy: "授权策略已停用",
	system_only: "仅允许系统超管操作",
	missing_permission: "当前角色未获得此页面或功能权限",
	wrong_organization: "资源不存在",
	wrong_project: "资源不存在",
	wrong_owner: "仅允许会话创建者操作",
	missing_resource: "资源不存在",
	grant_exceeds_permissions: "不能授予超出自己权限的角色",
	grant_exceeds_scope: "不能授予超出自己访问范围的客户",
	protected_member: "目标为受保护账号或当前账号",
};
export class AccessDeniedError extends HttpInputError {
	constructor(
		message: string,
		readonly decision?: Decision,
	) {
		super(
			message,
			decision && ["wrong_organization", "wrong_project", "missing_resource"].includes(decision.reason) ? 404 : 403,
		);
	}
}
export function assertDecision(decision: Decision): void {
	if (!decision.allowed) throw new AccessDeniedError(decisionMessages[decision.reason] ?? "授权被拒绝", decision);
}

export async function evaluateRequest(database: Database, principal: Principal, method: string, path: string) {
	const systemBoundary =
		path.startsWith("/api/rbac/configuration") ||
		path.startsWith("/api/organizations") ||
		path === "/api/rbac/catalog" ||
		(path.startsWith("/api/rbac/roles") && method !== "GET") ||
		/^\/api\/users\/[^/]+\/access$/.test(path);
	const match = await findHttpPolicy(database, method, path);
	const policy = match?.policy ?? null;
	const resource = policy?.resourceParam
		? await resolveResource(database, policy.resourceType, match!.params[policy.resourceParam] ?? "")
		: { organizationId: principal.organizationId };
	const decision: Decision =
		systemBoundary && !principal.systemAdmin
			? { allowed: false, reason: "system_only", policyId: policy?.id ?? null, revision: principal.revision }
			: decide(principal, policy, resource ?? {});
	return { decision, policy, resource };
}
export async function authorizeRequest(
	database: Database,
	principal: Principal,
	method: string,
	path: string,
): Promise<Decision> {
	const result = await evaluateRequest(database, principal, method, path);
	assertDecision(result.decision);
	if (result.resource?.projectId) {
		const deletingProject = method === "DELETE" && result.policy?.path === "/api/projects/:projectId";
		await assertProjectAccess(
			database,
			result.resource.projectId,
			!["GET", "HEAD"].includes(method) && !deletingProject,
		);
	}
	return result.decision;
}
export async function authorizeArtifact(database: Database, principal: Principal, key: string): Promise<void> {
	const resource = await resolveArtifact(database, key);
	if (!resource) throw new HttpInputError("证据文件不存在", 404);
	assertDecision(decide(principal, await findPolicy(database, `artifact.${resource.kind}.read`), resource));
	if (resource.projectId) await assertProjectAccess(database, resource.projectId);
}
export async function authorizeAction(
	database: Database,
	actor: ExecutionActor,
	action: string,
	resource: Resource,
): Promise<Principal> {
	const principal = await loadActorPrincipal(database, actor, resource.organizationId ?? "");
	assertDecision(decide(principal, await findPolicy(database, action), resource));
	if (resource.projectId) await assertProjectAccess(database, resource.projectId, true);
	return principal as Principal;
}

/** For database mutations: reauthorize under the same locks used by role/scope/credential revocation. No network work in callback. */
export async function withAuthorizedAction<T>(
	database: Database,
	actor: ExecutionActor,
	action: string,
	resource: Resource,
	work: (tx: Database, principal: Principal) => Promise<T>,
): Promise<T> {
	return database.transaction(async (tx) => {
		await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [resource.organizationId]);
		if (actor.kind === "user") await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [actor.userId]);
		const principal = await authorizeAction(tx, actor, action, resource);
		return work(tx, principal);
	});
}
export async function principalForIdentity(
	database: Database,
	identity: { id: string | null; localBypass?: boolean; organizationId: string; principal?: Principal },
): Promise<Principal> {
	if (identity.principal) return identity.principal;
	const principal = await loadActorPrincipal(database, actorFromIdentity(identity), identity.organizationId);
	if (!principal) throw new AccessDeniedError("授权身份已失效");
	return principal;
}
export { findHttpPolicy, findPolicy } from "./policies";
export { actorFromIdentity, loadActorPrincipal, loadPrincipal } from "./principal";
