import type { Database } from "@geo/core";
import type { Identity } from "./auth";
import { setDesktopPrincipalResolver } from "./authorization/principal";

export type { Identity } from "./auth";
export { HttpInputError } from "./utils";

/** Private workspaces grant the creator access locally; cloud project IDs belong to the legacy server DB. */
export async function scopeDesktopIdentity(database: Database, identity: Identity): Promise<Identity> {
	if (identity.allProjects) return identity;
	const projectIds = (
		await database.query<{ id: string }>(
			"SELECT p.id FROM user_project_access a JOIN projects p ON p.id=a.project_id WHERE a.user_id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL",
			[identity.id, identity.organizationId],
		)
	).rows.map((row) => row.id);
	return { ...identity, projectIds, principal: { ...identity.principal, projects: { all: false, ids: projectIds } } };
}

/** Mirror only this authenticated subject, never a server password/session or another member. */
export async function installDesktopIdentity(
	database: Database,
	identity: Identity,
	policies: Record<string, unknown>[],
	resolve: () => Promise<Identity | null>,
	permissions: Record<string, unknown>[] = [],
): Promise<void> {
	if (!identity.id || identity.localBypass) throw new Error("本地工作区需要云端账号");
	for (const id of new Set([identity.organizationId, identity.homeOrganizationId]))
		await database.query(
			"INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
			[id, identity.organizationName],
		);
	await database.query(
		`INSERT INTO users(id,organization_id,email,display_name,role,password_hash,is_super_admin,all_projects)
		VALUES($1,$2,$3,$4,$5,'desktop-no-password',$6,$7) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,is_super_admin=excluded.is_super_admin,all_projects=excluded.all_projects,disabled_at=NULL`,
		[
			identity.id,
			identity.homeOrganizationId,
			identity.email,
			identity.displayName,
			identity.role,
			identity.isSuperAdmin,
			identity.allProjects,
		],
	);
	// Policy definitions come from the authenticated cloud control plane, not from the snapshot.
	await database.transaction(async (tx) => {
		if (permissions.length) {
			await tx.query("UPDATE permissions SET enabled=false");
			const columns = [
				"key",
				"kind",
				"group_label",
				"label",
				"parent_key",
				"position",
				"enabled",
				"built_in",
				"system_only",
				"navigation_key",
				"icon_key",
				"version",
			];
			const known = new Set<string>();
			const ordered: Record<string, unknown>[] = [];
			const visit = (permission: Record<string, unknown>) => {
				const key = String(permission.key);
				if (known.has(key)) return;
				known.add(key);
				const parent = permissions.find((p) => p.key === permission.parent_key);
				if (parent) visit(parent);
				ordered.push(permission);
			};
			permissions.forEach(visit);
			for (const permission of ordered) {
				const fields = columns.filter((key) => Object.hasOwn(permission, key));
				await tx.query(
					`INSERT INTO permissions(${fields.join(",")}) VALUES(${fields.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT(key) DO UPDATE SET ${fields
						.filter((key) => key !== "key")
						.map((key) => `${key}=excluded.${key}`)
						.join(",")}`,
					fields.map((key) => permission[key]),
				);
			}
		}
		await tx.query("DELETE FROM authorization_policies");
		const columns = [
			"id",
			"policy_key",
			"kind",
			"label",
			"http_method",
			"path_pattern",
			"any_of",
			"all_of",
			"resource_type",
			"resource_param",
			"scope",
			"owner_only",
			"system_only",
			"allow_suspended",
			"enabled",
			"version",
			"built_in",
		];
		for (const policy of policies)
			await tx.query(
				`INSERT INTO authorization_policies (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
				columns.map((key) => policy[key]),
			);
	});
	setDesktopPrincipalResolver(async (transaction) => {
		const authenticated = await resolve();
		const current = authenticated ? await scopeDesktopIdentity(transaction, authenticated) : null;
		return current
			? {
					...current.principal,
					email: current.email,
					displayName: current.displayName,
					legacyRole: current.role,
					organizationName: current.organizationName,
					homeOrganizationName: current.organizationName,
				}
			: null;
	});
}
