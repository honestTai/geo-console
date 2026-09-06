import { matchRoute, type Policy } from "@geo/authorization";
import type { Database } from "@geo/core";
import type { ResourceType } from "./resources";

export type StoredPolicy = Policy & {
	kind: "http" | "artifact" | "execution";
	label: string;
	method: string | null;
	path: string | null;
	resourceType: ResourceType;
	resourceParam: string | null;
	version: number;
	builtIn: boolean;
};
export type PolicyRow = {
	id: string;
	policy_key: string;
	kind: StoredPolicy["kind"];
	label: string;
	http_method: string | null;
	path_pattern: string | null;
	any_of: string[];
	all_of: string[];
	resource_type: ResourceType;
	resource_param: string | null;
	scope: Policy["scope"];
	owner_only: boolean;
	system_only: boolean;
	allow_suspended: boolean;
	enabled: boolean;
	version: number;
	built_in: boolean;
};
export function policyFromRow(row: PolicyRow): StoredPolicy {
	return {
		id: row.id,
		key: row.policy_key,
		kind: row.kind,
		label: row.label,
		method: row.http_method,
		path: row.path_pattern,
		anyOf: row.any_of,
		allOf: row.all_of,
		resourceType: row.resource_type,
		resourceParam: row.resource_param,
		scope: row.scope,
		ownerOnly: row.owner_only,
		systemOnly: row.system_only,
		allowSuspended: row.allow_suspended,
		enabled: row.enabled,
		version: row.version,
		builtIn: row.built_in,
	};
}
export async function findPolicy(database: Database, key: string): Promise<StoredPolicy | null> {
	const row = (await database.query<PolicyRow>("SELECT * FROM authorization_policies WHERE policy_key=$1", [key]))
		.rows[0];
	return row ? policyFromRow(row) : null;
}
export async function findHttpPolicy(
	database: Database,
	method: string,
	path: string,
): Promise<{ policy: StoredPolicy; params: Record<string, string> } | null> {
	const rows = (
		await database.query<PolicyRow>(
			"SELECT * FROM authorization_policies WHERE kind='http' AND http_method=$1 ORDER BY policy_key",
			[method.toUpperCase()],
		)
	).rows;
	const matches = rows
		.flatMap((row) => {
			const match = matchRoute(row.path_pattern ?? "", path);
			return match ? [{ policy: policyFromRow(row), ...match }] : [];
		})
		.sort((a, b) => b.specificity - a.specificity);
	if (!matches.length) return null;
	if (matches[1]?.specificity === matches[0].specificity) throw new Error("存在相同优先级的重叠授权策略，已拒绝请求");
	return matches[0];
}
