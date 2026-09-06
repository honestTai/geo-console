/** Pure, dependency-free authorization semantics. Database, HTTP and model SDKs must not enter this package. */
export type ExecutionActor =
	| { kind: "user"; userId: string }
	| { kind: "service"; serviceId: "report-scheduler" }
	| { kind: "local" }
	| { kind: "unassigned" };
export type ProjectScope = { all: boolean; ids: string[] };
export type Principal = {
	actor: ExecutionActor;
	userId: string | null;
	organizationId: string;
	homeOrganizationId: string;
	active: boolean;
	organizationSuspended: boolean;
	systemAdmin: boolean;
	permissions: string[];
	configuredPermissions: string[];
	roles: Array<{ id: string; name: string }>;
	projects: ProjectScope;
	revision: string;
	credentialVersion: number;
};
export type Requirements = { anyOf: string[]; allOf: string[] };
export type Policy = Requirements & {
	id: string;
	key: string;
	enabled: boolean;
	systemOnly: boolean;
	allowSuspended: boolean;
	scope: "organization" | "project" | "system";
	ownerOnly: boolean;
};
export type Resource = { organizationId?: string; projectId?: string; ownerUserId?: string | null };
export type DecisionReason =
	| "allowed"
	| "unauthenticated"
	| "disabled_subject"
	| "suspended_organization"
	| "unknown_policy"
	| "disabled_policy"
	| "system_only"
	| "missing_permission"
	| "wrong_organization"
	| "wrong_project"
	| "wrong_owner"
	| "missing_resource"
	| "grant_exceeds_permissions"
	| "grant_exceeds_scope"
	| "protected_member";
export type Decision = { allowed: boolean; reason: DecisionReason; policyId: string | null; revision: string | null };
export function hasRequirements(permissions: readonly string[], requirements: Requirements): boolean {
	const keys = new Set(permissions);
	return (
		(requirements.anyOf.length > 0 || requirements.allOf.length > 0) &&
		requirements.allOf.every((k) => keys.has(k)) &&
		(!requirements.anyOf.length || requirements.anyOf.some((k) => keys.has(k)))
	);
}
export function decide(principal: Principal | null, policy: Policy | null, resource: Resource = {}): Decision {
	const result = (reason: DecisionReason): Decision => ({
		allowed: reason === "allowed",
		reason,
		policyId: policy?.id ?? null,
		revision: principal?.revision ?? null,
	});
	if (!principal) return result("unauthenticated");
	if (!principal.active) return result("disabled_subject");
	if (!policy) return result("unknown_policy");
	if (!policy.enabled) return result("disabled_policy");
	if (principal.organizationSuspended && !policy.allowSuspended) return result("suspended_organization");
	if (policy.systemOnly && !principal.systemAdmin) return result("system_only");
	const scopeDecision = resourceDecision(principal, policy, resource);
	if (scopeDecision !== "allowed") return result(scopeDecision);
	if (!principal.systemAdmin && !hasRequirements(principal.permissions, policy)) return result("missing_permission");
	return result("allowed");
}

function resourceDecision(principal: Principal, policy: Policy, resource: Resource): DecisionReason {
	if (policy.scope !== "system") {
		if (!resource.organizationId) return "missing_resource";
		if (resource.organizationId !== principal.organizationId) return "wrong_organization";
	}
	if (policy.scope === "project") {
		if (!resource.projectId) return "missing_resource";
		if (!principal.projects.all && !principal.projects.ids.includes(resource.projectId)) return "wrong_project";
	}
	if (policy.ownerOnly && !principal.systemAdmin && resource.ownerUserId !== principal.userId) return "wrong_owner";
	return "allowed";
}

/** The same rule drives assignable options, can_manage and write enforcement. Dormant configured rights are included. */
export function decideDelegation(
	actor: Principal,
	target: { configuredPermissions: string[]; projects: ProjectScope; userId?: string | null; systemAdmin?: boolean },
): DecisionReason {
	if (!actor.active) return "disabled_subject";
	if (actor.organizationSuspended && !actor.systemAdmin) return "suspended_organization";
	if (target.systemAdmin || (target.userId !== undefined && target.userId === actor.userId)) return "protected_member";
	if (actor.systemAdmin) return "allowed";
	if (target.configuredPermissions.some((key) => !actor.permissions.includes(key))) return "grant_exceeds_permissions";
	if (
		!actor.projects.all &&
		(target.projects.all || target.projects.ids.some((id) => !actor.projects.ids.includes(id)))
	)
		return "grant_exceeds_scope";
	return "allowed";
}

export type RouteMatch = { params: Record<string, string>; specificity: number };
export function matchRoute(pattern: string, path: string): RouteMatch | null {
	if (!pattern.startsWith("/") || !path.startsWith("/") || /[?#]/.test(path)) return null;
	const expected = pattern.split("/").slice(1),
		actual = path.split("/").slice(1),
		params: Record<string, string> = {};
	if (actual.some((part) => decodeSegment(part) === null)) return null;
	let specificity = 0;
	for (let index = 0; index < expected.length; index++) {
		const part = expected[index];
		if (part === "*") return index === expected.length - 1 ? { params, specificity } : null;
		if (!actual[index]) return null;
		if (part.startsWith(":")) {
			const decoded = decodeSegment(actual[index]);
			// All segments were validated before matching, including wildcard tails.
			params[part.slice(1)] = decoded as string;
			specificity += 1;
		} else {
			if (part !== actual[index]) return null;
			specificity += 10;
		}
	}
	return expected.length === actual.length ? { params, specificity: specificity + 1 } : null;
}

function decodeSegment(value: string): string | null {
	try {
		const decoded = decodeURIComponent(value);
		return !decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes(String.fromCharCode(0))
			? null
			: decoded;
	} catch {
		return null;
	}
}

/** Conservative template intersection, used to prevent configurable policies from shadowing existing endpoints. */
export function routesOverlap(left: string, right: string): boolean {
	const a = left.split("/"),
		b = right.split("/");
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] === "*" || b[i] === "*") return true;
		if (a[i] === undefined || b[i] === undefined) return false;
		if (a[i] !== b[i] && !a[i].startsWith(":") && !b[i].startsWith(":")) return false;
	}
	return true;
}
