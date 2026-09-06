import { randomUUID } from "node:crypto";
import { type ExecutionActor, routesOverlap } from "@geo/authorization";
import type { Database } from "@geo/core";
import { z } from "zod";
import { type PaginationInput, paginated } from "../pagination";
import { HttpInputError } from "../utils";
import { evaluateRequest } from "./index";
import { type PolicyRow, policyFromRow } from "./policies";
import { loadActorPrincipal, loadPrincipal } from "./principal";
import { resourceResolvers } from "./resources";

const key = z
	.string()
	.trim()
	.min(1)
	.max(160)
	.regex(/^[a-z][a-z0-9_.:-]*$/);
const permissionInput = z.strictObject({
	key,
	kind: z.enum(["page", "action"]),
	label: z.string().trim().min(1).max(120),
	groupLabel: z.string().trim().min(1).max(80),
	parentKey: key.nullable().default(null),
	enabled: z.boolean().default(true),
	navigationKey: z.string().trim().min(1).nullable().default(null),
});
const policyInput = z.strictObject({
	key: z.string().trim().min(1).max(240),
	kind: z.enum(["http", "artifact", "execution"]),
	label: z.string().trim().min(1).max(160),
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).nullable(),
	path: z.string().max(240).nullable(),
	anyOf: z.array(key).max(100),
	allOf: z.array(key).max(100),
	resourceType: z.enum(
		Object.keys(resourceResolvers) as [keyof typeof resourceResolvers, ...Array<keyof typeof resourceResolvers>],
	),
	resourceParam: z
		.string()
		.regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
		.nullable(),
	scope: z.enum(["organization", "project", "system"]),
	ownerOnly: z.boolean(),
	systemOnly: z.boolean(),
	allowSuspended: z.boolean(),
	enabled: z.boolean(),
	version: z.int().positive().optional(),
});

export async function requireSystemAdministrator(database: Database, actor: ExecutionActor, organizationId: string) {
	const principal = await loadActorPrincipal(database, actor, organizationId);
	if (!principal?.active || !principal.systemAdmin) throw new HttpInputError("仅系统超管可以修改授权配置", 403);
	return principal;
}
async function configurationAudit(
	db: Database,
	actor: ExecutionActor,
	org: string,
	action: string,
	target: string,
	before: unknown,
	after: unknown,
) {
	await db.query(
		"INSERT INTO audit_logs(id,organization_id,actor_user_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'authorization',$5,$6::jsonb)",
		[randomUUID(), org, actor.kind === "user" ? actor.userId : null, action, target, JSON.stringify({ before, after })],
	);
}
export async function savePermission(
	database: Database,
	actor: ExecutionActor,
	organizationId: string,
	input: unknown,
): Promise<void> {
	const data = permissionInput.parse(input);
	await database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock(720026,21)");
		await requireSystemAdministrator(tx, actor, organizationId);
		const current = (
			await tx.query<Record<string, unknown>>("SELECT * FROM permissions WHERE key=$1 FOR UPDATE", [data.key])
		).rows[0];
		if (current?.system_only && !data.enabled) throw new HttpInputError("系统管理权限不能停用，以免失去恢复入口");
		if (current && (current.kind !== data.kind || current.navigation_key !== data.navigationKey))
			throw new HttpInputError("内置权限的类型和导航绑定不能修改");
		if (data.parentKey) {
			const parent = (
				await tx.query<{ kind: string; system_only: boolean }>(
					"SELECT kind,system_only FROM permissions WHERE key=$1",
					[data.parentKey],
				)
			).rows[0];
			if (data.kind !== "action" || !parent || parent.kind !== "page" || (parent.system_only && !current?.system_only))
				throw new HttpInputError("父权限必须是同级安全边界内的页面权限");
		}
		await tx.query(
			`INSERT INTO permissions(key,kind,label,group_label,parent_key,enabled,navigation_key,position,built_in)
		 VALUES($1,$2,$3,$4,$5,$6,$7,1000,false) ON CONFLICT(key) DO UPDATE SET label=excluded.label,group_label=excluded.group_label,parent_key=excluded.parent_key,enabled=excluded.enabled`,
			[data.key, data.kind, data.label, data.groupLabel, data.parentKey, data.enabled, data.navigationKey],
		);
		await tx.query("UPDATE organizations SET authz_version=authz_version+1");
		await configurationAudit(
			tx,
			actor,
			organizationId,
			"authorization.permission_saved",
			data.key,
			current ?? null,
			data,
		);
	});
}

function validateHttpBinding(data: z.infer<typeof policyInput>) {
	if (data.kind === "http") {
		if (!data.method || !data.path?.startsWith("/api/") || /[?#\\]/.test(data.path))
			throw new HttpInputError("HTTP 策略必须指定方法和 /api/ 路由模板");
		const segments = data.path.split("/").slice(1),
			parameters = segments.filter((p) => p.startsWith(":"));
		if (
			segments.some((p, i) => !p || (p.includes("*") && (p !== "*" || i !== segments.length - 1))) ||
			new Set(parameters).size !== parameters.length ||
			parameters.some((p) => !/^:[a-zA-Z][a-zA-Z0-9_]*$/.test(p))
		)
			throw new HttpInputError("路由模板无效");
		if (data.resourceParam && !parameters.includes(`:${data.resourceParam}`))
			throw new HttpInputError("资源参数必须来自路由模板");
	} else if (data.method || data.path || data.resourceParam) throw new HttpInputError("非 HTTP 策略不能设置路由参数");
}
function validatePolicyInput(data: z.infer<typeof policyInput>) {
	validateHttpBinding(data);
	if (!data.anyOf.length && !data.allOf.length && !data.systemOnly)
		throw new HttpInputError("策略至少需要一个权限条件");
	if (data.scope === "project" && data.resourceType === "organization")
		throw new HttpInputError("项目策略必须绑定项目资源");
	if (data.scope === "system" && !data.systemOnly) throw new HttpInputError("系统范围必须限定系统超管");
	if (data.kind === "http" && data.scope === "project" && !data.resourceParam)
		throw new HttpInputError("项目接口必须绑定路由中的资源 ID");
	if (data.allowSuspended && !data.systemOnly) throw new HttpInputError("只有系统管理策略可在封禁机构中使用");
}
const bindingKeys = [
	"kind",
	"method",
	"path",
	"resourceType",
	"resourceParam",
	"scope",
	"ownerOnly",
	"systemOnly",
	"allowSuspended",
] as const;
export async function savePolicy(
	database: Database,
	actor: ExecutionActor,
	organizationId: string,
	input: unknown,
	id?: string,
): Promise<{ id: string }> {
	const data = policyInput.parse(input);
	validatePolicyInput(data);
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate immutable bindings, referenced permissions, route collisions and optimistic version atomically before the audited write.
	return database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock(720026,21)");
		await requireSystemAdministrator(tx, actor, organizationId);
		const current = id
			? (await tx.query<PolicyRow>("SELECT * FROM authorization_policies WHERE id=$1 FOR UPDATE", [id])).rows[0]
			: null;
		if (id && !current) throw new HttpInputError("策略不存在", 404);
		const before = current ? policyFromRow(current) : null;
		if (before && data.version !== before.version) throw new HttpInputError("策略版本已变化，请刷新后重试", 409);
		if (before && (before.key !== data.key || bindingKeys.some((k) => before[k] !== data[k])))
			throw new HttpInputError("策略标识、资源绑定和安全边界创建后不可变；请只调整权限条件或新建策略");
		if (before?.builtIn && before.systemOnly && !data.enabled) throw new HttpInputError("系统管理策略不能停用");
		const keys = [...new Set([...data.anyOf, ...data.allOf])];
		if (
			keys.length &&
			(await tx.query("SELECT key FROM permissions WHERE key=ANY($1::text[])", [keys])).rows.length !== keys.length
		)
			throw new HttpInputError("策略引用了不存在的权限");
		if (!before && data.kind === "http") {
			const existingRoutes = (
				await tx.query<PolicyRow>("SELECT * FROM authorization_policies WHERE kind='http' AND http_method=$1", [
					data.method,
				])
			).rows;
			if (existingRoutes.some((p) => routesOverlap(p.path_pattern ?? "", data.path!)))
				throw new HttpInputError("新策略不能与已有路由重叠，请编辑原策略的权限条件", 409);
		}
		const duplicate = await tx.query(
			"SELECT id FROM authorization_policies WHERE (policy_key=$1 OR (http_method=$2 AND path_pattern=$3)) AND id<>$4",
			[data.key, data.method, data.path, id ?? ""],
		);
		if (duplicate.rows.length) throw new HttpInputError("策略键或路由已存在", 409);
		const resultId = id ?? randomUUID();
		if (before)
			await tx.query(
				`UPDATE authorization_policies SET policy_key=$2,label=$3,any_of=$4::jsonb,all_of=$5::jsonb,enabled=$6,version=version+1,updated_at=now() WHERE id=$1`,
				[resultId, data.key, data.label, JSON.stringify(data.anyOf), JSON.stringify(data.allOf), data.enabled],
			);
		else
			await tx.query(
				`INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,any_of,all_of,resource_type,resource_param,scope,owner_only,system_only,allow_suspended,enabled)
		 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
				[
					resultId,
					data.key,
					data.kind,
					data.label,
					data.method,
					data.path,
					JSON.stringify(data.anyOf),
					JSON.stringify(data.allOf),
					data.resourceType,
					data.resourceParam,
					data.scope,
					data.ownerOnly,
					data.systemOnly,
					data.allowSuspended,
					data.enabled,
				],
			);
		await tx.query("UPDATE organizations SET authz_version=authz_version+1");
		await configurationAudit(tx, actor, organizationId, "authorization.policy_saved", resultId, before, data);
		return { id: resultId };
	});
}
export async function listPolicies(database: Database, input: PaginationInput) {
	const search = input.search ? `%${input.search}%` : null;
	const total = Number(
		(
			await database.query<{ count: number }>(
				"SELECT count(*)::int AS count FROM authorization_policies WHERE $1::text IS NULL OR policy_key ILIKE $1 OR label ILIKE $1",
				[search],
			)
		).rows[0].count,
	);
	const rows = (
		await database.query<PolicyRow>(
			"SELECT * FROM authorization_policies WHERE $1::text IS NULL OR policy_key ILIKE $1 OR label ILIKE $1 ORDER BY kind,policy_key LIMIT $2 OFFSET $3",
			[search, input.pageSize, input.offset],
		)
	).rows;
	return { ...paginated(rows.map(policyFromRow), total, input), resourceTypes: Object.keys(resourceResolvers) };
}

export async function explainRequest(
	database: Database,
	actor: ExecutionActor,
	organizationId: string,
	input: unknown,
) {
	await requireSystemAdministrator(database, actor, organizationId);
	const data = z
		.strictObject({
			userId: z.string().min(1),
			method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			path: z.string().startsWith("/api/").max(500),
		})
		.parse(input);
	const principal = await loadPrincipal(database, { userId: data.userId, organizationId });
	if (!principal || (principal.homeOrganizationId !== organizationId && !principal.systemAdmin))
		throw new HttpInputError("当前机构中找不到该账号", 404);
	const result = await evaluateRequest(database, principal, data.method, data.path);
	return {
		...result,
		principal: {
			userId: principal.userId,
			roles: principal.roles,
			permissions: principal.permissions,
			configuredPermissions: principal.configuredPermissions,
			projects: principal.projects,
			revision: principal.revision,
		},
		dryRun: true,
	};
}
