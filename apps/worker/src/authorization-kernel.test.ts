import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Database, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it, vi } from "vitest";
import { approveAgentRun } from "./agent";
import { runOneAgentJob } from "./agent-jobs";
import { authenticateRequest, createUser, listUsers, login, resetMemberPassword } from "./auth";
import { authorizeAction, authorizeArtifact, authorizeRequest, loadPrincipal } from "./authorization";
import { explainRequest, savePermission, savePolicy } from "./authorization/configuration";
import { authorizeDraftExecution, authorizeWorkbenchTool, parseActor } from "./authorization/execution";
import { findPolicy } from "./authorization/policies";
import { loadPrincipals } from "./authorization/principal";
import { createRole, updateOrganizationPermissions, updateUserAccess } from "./rbac";

const actor = { kind: "user" as const, userId: "super" },
	admin = { id: "super", isSuperAdmin: true };
const firstPage = { page: 1, pageSize: 20, offset: 0, search: null };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
	const db = openMemoryDatabase();
	await migrateDatabase(db);
	await db.query(
		"INSERT INTO users(id,email,display_name,role,password_hash,is_super_admin) VALUES('super','super@test.invalid','超管','admin','test-only',true)",
	);
	await db.query(
		"INSERT INTO projects(id,name,website_url,domain,region,language,status) VALUES('A','甲','https://a.example','a.example','CN','zh-CN','active'),('B','乙','https://b.example','b.example','CN','zh-CN','active')",
	);
	const role = (
		await createRole(db, "default", {
			name: "测试成员",
			permissionKeys: ["page.overview", "project.onboard", "page.evidence", "workbench.run", "agent.approve"],
		})
	).id;
	const user = (
		await createUser(
			db,
			{
				email: "member@test.invalid",
				displayName: "成员",
				password: "old-password-for-test",
				roleIds: [role],
				allProjects: false,
				projectIds: ["A"],
			},
			"default",
			admin,
		)
	).id;
	return { db, user, role };
}
describe("unified authorization kernel", () => {
	it("member-page principals are loaded in one scoped SQL snapshot", async () => {
		const { db, user } = await fixture();
		try {
			const query = vi.fn(db.query.bind(db));
			const wrapped = { ...db, query } as Database;
			const rows = await loadPrincipals(wrapped, ["super", user], "default");
			expect(query).toHaveBeenCalledTimes(1);
			expect(rows).toHaveLength(2);
			expect(rows.find((row) => row.userId === user)?.projects.ids).toEqual(["A"]);
			expect(await loadPrincipals(db, [user], "another-organization")).toHaveLength(0);
		} finally {
			await db.close();
		}
	});
	it("workbench entry permission cannot substitute for domain writes and cancellation stops derived drafts", async () => {
		const { db, user } = await fixture();
		try {
			await db.query(
				"INSERT INTO agent_sessions(id,project_id,title,created_by,execution_actor) VALUES('session','A','工具授权',$1,$2::jsonb)",
				[user, JSON.stringify({ kind: "user", userId: user })],
			);
			await authorizeWorkbenchTool(db, "session", "read_project_context");
			await expect(authorizeWorkbenchTool(db, "session", "create_batch")).rejects.toThrow("权限");
			await expect(authorizeWorkbenchTool(db, "session", "unregistered_tool")).rejects.toThrow("未登记");
			await db.query(
				"INSERT INTO agent_runs(id,project_id,purpose,status,model,prompt_version,session_id,execution_actor) VALUES('run','A','prompt_research','queued','test','test','session',$1::jsonb)",
				[JSON.stringify({ kind: "user", userId: user })],
			);
			await authorizeDraftExecution(db, "run");
			await db.query("UPDATE agent_sessions SET cancelled_at=now() WHERE id='session'");
			await expect(authorizeDraftExecution(db, "run")).rejects.toThrow("取消");
		} finally {
			await db.close();
		}
	});
	it("service actor respects revoked organization entitlements", async () => {
		const { db } = await fixture();
		try {
			await updateOrganizationPermissions(db, "default", [], "super");
			await expect(
				authorizeAction(db, { kind: "service", serviceId: "report-scheduler" }, "agent.draft.report_narrative", {
					organizationId: "default",
					projectId: "A",
				}),
			).rejects.toThrow("权限");
		} finally {
			await db.close();
		}
	});
	it("configured routes cannot shadow built-in security bindings, including parameter/literal intersections", async () => {
		const { db } = await fixture();
		try {
			const base = {
				key: "shadow",
				kind: "http",
				label: "不允许遮蔽",
				method: "GET",
				path: "/api/:kind/A",
				anyOf: ["page.overview"],
				allOf: [],
				resourceType: "organization",
				resourceParam: null,
				scope: "organization",
				ownerOnly: false,
				systemOnly: false,
				allowSuspended: false,
				enabled: true,
			};
			await expect(savePolicy(db, actor, "default", base)).rejects.toMatchObject({ status: 409 });
		} finally {
			await db.close();
		}
	});
	it("loads grants and scope in one statement and never trusts a caller's superadmin flag", async () => {
		const { db, user } = await fixture();
		try {
			const query = vi.fn(db.query.bind(db));
			const wrapped = { ...db, query } as Database;
			const principal = await loadPrincipal(wrapped, { userId: user, organizationId: "other" });
			expect(query).toHaveBeenCalledTimes(1);
			expect(principal?.organizationId).toBe("default");
			expect(principal?.projects.ids).toEqual(["A"]);
			await expect(authorizeRequest(db, principal!, "POST", "/api/projects/B/analyze")).rejects.toMatchObject({
				status: 404,
			});
			await expect(
				authorizeRequest(db, principal!, "PUT", "/api/rbac/configuration/permissions"),
			).rejects.toMatchObject({ status: 403 });
		} finally {
			await db.close();
		}
	});
	it("requires functional access for known artifact URLs in addition to project ownership", async () => {
		const { db, user } = await fixture();
		try {
			await db.query(
				"INSERT INTO website_snapshots(id,project_id,url,domain,content_text,structured_data,content_hash,artifact_key,fetched_at) VALUES('e','A','https://a.example','a.example','evidence','[]',$1,'evidence/a.json',now())",
				["a".repeat(64)],
			);
			await authorizeArtifact(db, (await loadPrincipal(db, { userId: user }))!, "evidence/a.json");
			await updateUserAccess(db, "default", user, { roleIds: [], allProjects: false, projectIds: ["A"] });
			await expect(
				authorizeArtifact(db, (await loadPrincipal(db, { userId: user }))!, "evidence/a.json"),
			).rejects.toMatchObject({ status: 403 });
		} finally {
			await db.close();
		}
	});
	it("rejects an old verified password if reset commits before login's locked credential check", async () => {
		const { db, user } = await fixture();
		try {
			let arrive!: () => void, release!: () => void;
			const arrived = new Promise<void>((r) => {
					arrive = r;
				}),
				released = new Promise<void>((r) => {
					release = r;
				});
			// Gate transaction entry after candidate hash read/password verification; no DB transaction is held while resetting.
			const wrapped = {
				...db,
				query: db.query.bind(db),
				transaction: async <T>(work: (tx: Database) => Promise<T>) => {
					arrive();
					await released;
					return db.transaction(work);
				},
			} as Database;
			const pending = login(wrapped, { setHeader() {} } as unknown as ServerResponse, {
				email: "member@test.invalid",
				password: "old-password-for-test",
			});
			const outcome = pending.then(
				() => null,
				(e) => e,
			);
			await arrived;
			await resetMemberPassword(db, "default", user, { password: "new-password-for-test" }, admin);
			release();
			expect(await outcome).toBeInstanceOf(Error);
			expect(
				(await db.query("SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL", [user])).rows,
			).toHaveLength(0);
		} finally {
			await db.close();
		}
	});
	it("credential-version mismatch invalidates a token even without session deletion", async () => {
		const { db, user } = await fixture();
		try {
			await db.query(
				"INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES('s',$1,$2,now()+interval '1 hour')",
				[user, hash("token")],
			);
			expect((await loadPrincipal(db, { tokenHash: hash("token") }))?.userId).toBe(user);
			await db.query("UPDATE users SET password_hash='changed-test-hash' WHERE id=$1", [user]);
			expect(await loadPrincipal(db, { tokenHash: hash("token") })).toBeNull();
			expect(await authenticateRequest(db, { headers: { cookie: "geo_session=token" } } as IncomingMessage)).toBeNull();
		} finally {
			await db.close();
		}
	});
	it("dormant target rights give the same can_manage result as write enforcement", async () => {
		const { db, user, role } = await fixture();
		try {
			const managerRole = (
				await createRole(db, "default", {
					name: "成员管理员",
					permissionKeys: ["members.manage", "page.members", "page.overview"],
				})
			).id;
			const manager = (
				await createUser(
					db,
					{
						email: "manager@test.invalid",
						displayName: "管理员",
						password: "manager-password-test",
						roleIds: [managerRole],
						allProjects: false,
						projectIds: ["A"],
					},
					"default",
					admin,
				)
			).id;
			await updateOrganizationPermissions(db, "default", ["page.overview", "members.manage", "page.members"], "super");
			const users = await listUsers(db, "default", firstPage, { id: manager, isSuperAdmin: false });
			expect(users.items.find((u) => u.id === user)?.can_manage).toBe(false);
			await expect(
				resetMemberPassword(
					db,
					"default",
					user,
					{ password: "not-allowed-password" },
					{ id: manager, isSuperAdmin: false },
				),
			).rejects.toThrow("权限");
			expect(
				(await db.query("SELECT permission_key FROM role_permissions WHERE role_id=$1", [role])).rows.length,
			).toBeGreaterThan(1);
		} finally {
			await db.close();
		}
	});
	it("disabled actors cannot execute queued drafts or materialize their old auto-approval drafts", async () => {
		const { db, user } = await fixture();
		try {
			await db.query(
				"INSERT INTO agent_runs(id,project_id,purpose,status,model,prompt_version,execution_actor) VALUES('run','A','diagnosis','awaiting_approval','test','test',$1::jsonb)",
				[JSON.stringify({ kind: "user", userId: user })],
			);
			await db.query("UPDATE users SET disabled_at=now() WHERE id=$1", [user]);
			await expect(authorizeDraftExecution(db, "run")).rejects.toThrow("停用");
			await expect(approveAgentRun(db, "run", user, "workbench")).rejects.toThrow("停用");
			expect((await db.query("SELECT status FROM agent_runs WHERE id='run'")).rows[0].status).toBe("awaiting_approval");
			await db.query(
				"INSERT INTO jobs(id,type,payload,status) VALUES('j','agent_draft','{\"runId\":\"run\"}','pending')",
			);
			const runner = vi.fn();
			await runOneAgentJob(db, "authorization-test-worker", runner);
			expect(runner).not.toHaveBeenCalled();
			expect((await db.query("SELECT status FROM jobs WHERE id='j'")).rows[0].status).toBe("failed");
		} finally {
			await db.close();
		}
	});
	it("service identities are explicit and narrowly scoped; unassigned and fake local actors fail", async () => {
		const { db } = await fixture();
		try {
			const resource = { organizationId: "default", projectId: "A" };
			await authorizeAction(
				db,
				{ kind: "service", serviceId: "report-scheduler" },
				"agent.draft.report_narrative",
				resource,
			);
			for (const service of [
				{ kind: "unassigned" },
				{ kind: "local" },
				{ kind: "service", serviceId: "report-scheduler" },
			] as const)
				await expect(authorizeAction(db, service, "agent.approve", resource)).rejects.toMatchObject({ status: 403 });
			expect(parseActor("bad json")).toEqual({ kind: "unassigned" });
		} finally {
			await db.close();
		}
	});
	it("custom permissions take effect only after entitlement, role assignment and policy binding", async () => {
		const { db, user, role } = await fixture();
		try {
			await savePermission(db, actor, "default", {
				key: "custom.read",
				kind: "action",
				label: "扩展读",
				groupLabel: "扩展",
				parentKey: "page.overview",
			});
			await db.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'custom.read')", [role]);
			expect((await loadPrincipal(db, { userId: user }))!.permissions).not.toContain("custom.read");
			await db.query(
				"INSERT INTO organization_permissions(organization_id,permission_key) VALUES('default','custom.read')",
			);
			expect((await loadPrincipal(db, { userId: user }))!.permissions).toContain("custom.read");
			const input = {
				key: "custom.inspect",
				kind: "http",
				label: "扩展检查",
				method: "GET",
				path: "/api/extensions/:id",
				anyOf: ["custom.read"],
				allOf: [],
				resourceType: "project",
				resourceParam: "id",
				scope: "project",
				ownerOnly: false,
				systemOnly: false,
				allowSuspended: false,
				enabled: true,
			};
			await savePolicy(db, actor, "default", input);
			const result = await explainRequest(db, actor, "default", {
				userId: user,
				method: "GET",
				path: "/api/extensions/A",
			});
			expect(result.decision.allowed).toBe(true);
			const outside = await explainRequest(db, actor, "default", {
				userId: user,
				method: "GET",
				path: "/api/extensions/B",
			});
			expect(outside.decision.reason).toBe("wrong_project");
			await savePermission(db, actor, "default", {
				key: "custom.read",
				kind: "action",
				label: "扩展读",
				groupLabel: "扩展",
				enabled: false,
			});
			await expect(
				authorizeRequest(db, (await loadPrincipal(db, { userId: user }))!, "GET", "/api/extensions/A"),
			).rejects.toThrow("权限");
		} finally {
			await db.close();
		}
	});
	it("policy versions reject stale edits and security bindings cannot be weakened", async () => {
		const { db, user } = await fixture();
		try {
			const p = (await findPolicy(db, "workbench.execute"))!;
			const { id, builtIn: _builtIn, ...input } = p;
			await savePolicy(db, actor, "default", { ...input, label: "工作台执行权限" }, id);
			await expect(savePolicy(db, actor, "default", input, id)).rejects.toMatchObject({ status: 409 });
			await expect(
				savePolicy(db, actor, "default", { ...input, version: 2, scope: "organization" }, id),
			).rejects.toThrow("安全边界");
			await expect(
				savePermission(db, { kind: "user", userId: user }, "default", {
					key: "evil.write",
					kind: "action",
					label: "不允许",
					groupLabel: "测试",
				}),
			).rejects.toMatchObject({ status: 403 });
			expect((await db.query("SELECT id FROM audit_logs WHERE action LIKE 'authorization.%'")).rows).toHaveLength(1);
		} finally {
			await db.close();
		}
	});
});
