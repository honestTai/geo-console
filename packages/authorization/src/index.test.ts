import { describe, expect, it } from "vitest";
import {
	decide,
	decideDelegation,
	hasRequirements,
	matchRoute,
	type Policy,
	type Principal,
	routesOverlap,
} from "./index";

const principal: Principal = {
	actor: { kind: "user", userId: "u" },
	userId: "u",
	organizationId: "o",
	homeOrganizationId: "o",
	active: true,
	organizationSuspended: false,
	systemAdmin: false,
	permissions: ["page.read", "record.write"],
	configuredPermissions: ["page.read", "record.write"],
	roles: [],
	projects: { all: false, ids: ["a"] },
	revision: "1:2",
	credentialVersion: 0,
};
const policy: Policy = {
	id: "p",
	key: "test",
	enabled: true,
	systemOnly: false,
	allowSuspended: false,
	scope: "project",
	ownerOnly: false,
	anyOf: ["page.read"],
	allOf: ["record.write"],
};
describe("authorization semantics", () => {
	it("detects overlapping templates regardless of which side has a named parameter", () => {
		expect(routesOverlap("/api/projects/:id", "/api/:kind/sample-id")).toBe(true);
		expect(routesOverlap("/api/settings/*", "/api/settings/providers/:id")).toBe(true);
		expect(routesOverlap("/api/projects/:id", "/api/extensions/:id")).toBe(false);
	});
	it("fails closed for missing subjects, policies and required resources", () => {
		expect(decide(null, policy).reason).toBe("unauthenticated");
		expect(decide(principal, null).reason).toBe("unknown_policy");
		expect(decide(principal, policy).reason).toBe("missing_resource");
		expect(decide({ ...principal, active: false }, policy).reason).toBe("disabled_subject");
	});
	it("combines any-of and all-of without treating empty requirements as public", () => {
		expect(hasRequirements(principal.permissions, policy)).toBe(true);
		expect(hasRequirements(["page.read"], policy)).toBe(false);
		expect(hasRequirements([], { anyOf: [], allOf: [] })).toBe(false);
	});
	it("never lets functional permission bypass tenant, project or owner scope", () => {
		expect(decide(principal, policy, { organizationId: "other", projectId: "a" }).reason).toBe("wrong_organization");
		expect(decide(principal, policy, { organizationId: "o", projectId: "b" }).reason).toBe("wrong_project");
		expect(
			decide(principal, { ...policy, ownerOnly: true }, { organizationId: "o", projectId: "a", ownerUserId: "other" })
				.reason,
		).toBe("wrong_owner");
		expect(decide(principal, policy, { organizationId: "o", projectId: "a" }).allowed).toBe(true);
	});
	it("keeps suspension and disabled policy effective even for system administrators", () => {
		const admin = { ...principal, systemAdmin: true };
		expect(decide(admin, { ...policy, enabled: false }).reason).toBe("disabled_policy");
		expect(decide({ ...admin, organizationSuspended: true }, policy).reason).toBe("suspended_organization");
		expect(decide(admin, policy, { organizationId: "other", projectId: "a" }).allowed).toBe(false);
	});
	it("uses configured dormant grants for delegation and protects self/admin", () => {
		expect(
			decideDelegation(principal, { configuredPermissions: ["dormant.write"], projects: { all: false, ids: ["a"] } }),
		).toBe("grant_exceeds_permissions");
		expect(decideDelegation(principal, { configuredPermissions: [], projects: { all: true, ids: [] } })).toBe(
			"grant_exceeds_scope",
		);
		expect(decideDelegation(principal, { ...principal, userId: "u" })).toBe("protected_member");
	});
	it("matches exact routes before variables and wildcards, rejects malformed identifiers", () => {
		expect(matchRoute("/api/users/options", "/api/users/options")!.specificity).toBeGreaterThan(
			matchRoute("/api/users/:id", "/api/users/options")!.specificity,
		);
		for (const path of [
			"/api/users/a%2Fb",
			"/api/users/a%5Cb",
			"/api/users/%00",
			"/api/users/%ZZ",
			"/api/users/a/extra",
		])
			expect(matchRoute("/api/users/:id", path)).toBeNull();
		expect(matchRoute("/api/users/:id", "/api/users/u")?.params).toEqual({ id: "u" });
	});
});
