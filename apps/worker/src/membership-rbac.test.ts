import type { IncomingMessage, ServerResponse } from "node:http";
import { type Database, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import {
	authenticateRequest,
	changeOwnPassword,
	createUser,
	disableUser,
	listUsers,
	login,
	resetMemberPassword,
	restoreUser,
} from "./auth";
import { listMemberOptions } from "./member-access";
import {
	createRole,
	deleteRole,
	resolveEffectiveAccess,
	seedOrganizationRbac,
	updateOrganizationPermissions,
	updateRole,
	updateUserAccess,
} from "./rbac";
import { createOrganization, setOrganizationStatus } from "./tenancy";

const password = "test-rbac-password-2026";
const admin = { id: "super", isSuperAdmin: true };
const page = { page: 1, pageSize: 50, offset: 0, search: null };
const response = { setHeader() {} } as unknown as ServerResponse;
const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;
const input = (name: string, extra: Record<string, unknown> = {}) => ({
	email: `${name}@example.invalid`,
	displayName: name,
	password,
	...extra,
});
async function fixture() {
	const db = openMemoryDatabase();
	await migrateDatabase(db);
	await db.query(
		"INSERT INTO users(id,email,display_name,role,is_super_admin,password_hash) VALUES('super','super@example.invalid','超管','admin',true,'internal-test-only')",
	);
	const org = (await createOrganization(db, { name: "RBAC 隔离测试" }, admin.id)).id;
	for (const id of ["A", "B"])
		await db.query(
			`INSERT INTO projects(id,organization_id,name,website_url,domain,region,language,aliases,status) VALUES($1,$2,$1,'https://example.invalid','example.invalid','CN','zh-CN','[]','draft')`,
			[id, org],
		);
	const managerRole = (
		await createRole(db, org, { name: "成员管理", permissionKeys: ["page.members", "members.manage", "page.overview"] })
	).id;
	const readerRole = (await createRole(db, org, { name: "项目只读", permissionKeys: ["page.overview"] })).id;
	const manager = (
		await createUser(
			db,
			input("manager", { roleIds: [managerRole], allProjects: false, projectIds: ["A"] }),
			org,
			admin,
		)
	).id;
	const reader = (
		await createUser(db, input("reader", { roleIds: [readerRole], allProjects: false, projectIds: ["A"] }), org, admin)
	).id;
	const adminRole = (
		await db.query<{ id: string }>("SELECT id FROM roles WHERE organization_id=$1 AND system_key='admin'", [org])
	).rows[0].id;
	return { db, org, managerRole, readerRole, manager: { id: manager, isSuperAdmin: false }, reader, adminRole };
}
async function withFixture(work: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
	const f = await fixture();
	try {
		await work(f);
	} finally {
		await f.db.close();
	}
}

describe("Demo 复现的成员/RBAC 问题", () => {
	it("新机构默认角色不得混入系统权限，普通机构管理员能够分配分析师", () =>
		withFixture(async ({ db, org, adminRole }) => {
			const forbidden = await db.query(
				"SELECT rp.permission_key FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.key=rp.permission_key WHERE r.organization_id=$1 AND p.system_only=true",
				[org],
			);
			expect(forbidden.rows).toHaveLength(0);
			const memberAdmin = await createUser(
				db,
				input("standard-admin", { roleIds: [adminRole], allProjects: true }),
				org,
				admin,
			);
			const actor = { id: memberAdmin.id, isSuperAdmin: false };
			const options = await listMemberOptions(db, org, "roles", page, actor);
			const analyst = options.items.find((role) => role.system_key === "analyst");
			expect(analyst).toBeTruthy();
			const member = await createUser(db, input("standard-analyst", { roleIds: [analyst!.id] }), org, actor);
			expect(member.id).toBeTruthy();
			await expect(
				db.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'organization.manage')", [adminRole]),
			).rejects.toThrow("System-only");
			await expect(
				db.query(
					"INSERT INTO organization_permissions(organization_id,permission_key) VALUES($1,'page.organizations')",
					[org],
				),
			).rejects.toThrow("System-only");
		}));
	it("受限管理员不能授予更高角色、全部客户或未获授权的客户", () =>
		withFixture(async ({ db, org, manager, readerRole, adminRole }) => {
			for (const [name, extra] of [
				["higher", { roleIds: [adminRole], allProjects: false }],
				["all", { roleIds: [readerRole], allProjects: true }],
				["outside", { roleIds: [readerRole], allProjects: false, projectIds: ["B"] }],
			] as const)
				await expect(createUser(db, input(name, extra), org, manager)).rejects.toMatchObject({ name: "Error" });
			expect(
				(
					await db.query(
						"SELECT id FROM users WHERE email IN ('higher@example.invalid','all@example.invalid','outside@example.invalid')",
					)
				).rows,
			).toEqual([]);
			const created = await createUser(
				db,
				input("allowed", { roleIds: [readerRole], allProjects: false, projectIds: ["A"] }),
				org,
				manager,
			);
			expect(await resolveEffectiveAccess(db, created.id, org, false)).toMatchObject({
				permissions: ["page.overview"],
				allProjects: false,
				projectIds: ["A"],
			});
		}));
	it("分配候选只返回允许授予的角色和可见客户，可搜索分页", () =>
		withFixture(async ({ db, org, manager, managerRole, readerRole, adminRole }) => {
			const roles = await listMemberOptions(db, org, "roles", page, manager);
			expect(roles.items.map((r) => r.id).sort()).toEqual([managerRole, readerRole].sort());
			expect(roles.items.some((r) => r.id === adminRole)).toBe(false);
			const projects = await listMemberOptions(db, org, "projects", page, manager);
			expect(projects.items.map((p) => p.id)).toEqual(["A"]);
			expect(projects.allProjectsAllowed).toBe(false);
			const searched = await listMemberOptions(db, org, "roles", { ...page, search: "项目只读", pageSize: 1 }, manager);
			expect(searched.total).toBe(1);
			expect(searched.items[0].id).toBe(readerRole);
		}));
	it("高于操作者权限或范围的用户不能停用、恢复或重置密码", () =>
		withFixture(async ({ db, org, manager, adminRole, readerRole }) => {
			const higher = await createUser(
				db,
				input("higher-user", { roleIds: [adminRole], allProjects: true }),
				org,
				admin,
			);
			const outside = await createUser(
				db,
				input("outside-user", { roleIds: [readerRole], allProjects: true }),
				org,
				admin,
			);
			for (const user of [higher, outside]) {
				await expect(disableUser(db, user.id, manager.id, org, manager)).rejects.toThrow("超出");
				await expect(restoreUser(db, org, user.id, manager)).rejects.toThrow("超出");
				await expect(
					resetMemberPassword(db, org, user.id, { password: "different-strong-password" }, manager),
				).rejects.toThrow("超出");
			}
			expect((await listUsers(db, org, page, manager)).items.find((u) => u.id === higher.id)?.can_manage).toBe(false);
		}));
	it("重复邮箱和停用邮箱提供 409 业务提示，不泄漏数据库约束", () =>
		withFixture(async ({ db, org, reader, readerRole }) => {
			await expect(createUser(db, input("reader", { roleIds: [readerRole] }), org, admin)).rejects.toMatchObject({
				status: 409,
			});
			await expect(
				createUser(db, { ...input("unused"), email: "  READER@example.invalid  " }, org, admin),
			).rejects.toThrow("已是本机构成员");
			await disableUser(db, reader, admin.id, org, admin);
			await expect(createUser(db, input("reader"), org, admin)).rejects.toThrow("恢复");
		}));
	it("空角色明确表示无角色；默认角色改名不会改变身份；新成员默认无客户", () =>
		withFixture(async ({ db, org }) => {
			const empty = await createUser(db, input("empty", { roleIds: [] }), org, admin);
			expect(await resolveEffectiveAccess(db, empty.id, org, false)).toMatchObject({
				roles: [],
				permissions: [],
				allProjects: false,
				projectIds: [],
			});
			const role = (
				await db.query<{ id: string }>("SELECT id FROM roles WHERE organization_id=$1 AND system_key='viewer'", [org])
			).rows[0];
			await updateRole(db, org, role.id, { name: "审核专员（已改名）", permissionKeys: ["page.overview"] });
			const created = await createUser(db, input("renamed-default"), org, admin);
			expect((await resolveEffectiveAccess(db, created.id, org, false)).roles).toEqual([
				{ id: role.id, name: "审核专员（已改名）" },
			]);
		}));
	it("恢复停用账号不恢复旧会话；密码重置撤销会话", () =>
		withFixture(async ({ db, org, reader }) => {
			const first = await login(db, response, { email: "reader@example.invalid", password, organizationId: org });
			await disableUser(db, reader, admin.id, org, admin);
			expect(await authenticateRequest(db, request(first.sessionToken))).toBeNull();
			await restoreUser(db, org, reader, admin);
			expect(await authenticateRequest(db, request(first.sessionToken))).toBeNull();
			const second = await login(db, response, { email: "reader@example.invalid", password, organizationId: org });
			await resetMemberPassword(db, org, reader, { password: "new-valid-test-password" }, admin);
			expect(await authenticateRequest(db, request(second.sessionToken))).toBeNull();
			await expect(
				login(db, response, { email: "reader@example.invalid", password, organizationId: org }),
			).rejects.toThrow("邮箱或密码错误");
			expect(
				(
					await login(db, response, {
						email: "reader@example.invalid",
						password: "new-valid-test-password",
						organizationId: org,
					})
				).user.id,
			).toBe(reader);
		}));
	it("自己的密码需旧密码验证，只保留当前会话；审计中没有密码", () =>
		withFixture(async ({ db, org, reader }) => {
			const first = await login(db, response, { email: "reader@example.invalid", password, organizationId: org });
			const other = await login(db, response, { email: "reader@example.invalid", password, organizationId: org });
			await expect(
				changeOwnPassword(db, request(first.sessionToken), first.user, {
					currentPassword: "wrong",
					newPassword: "new-strong-password",
				}),
			).rejects.toThrow("当前密码不正确");
			await changeOwnPassword(db, request(first.sessionToken), first.user, {
				currentPassword: password,
				newPassword: "new-strong-password",
			});
			expect((await authenticateRequest(db, request(first.sessionToken)))?.id).toBe(reader);
			expect(await authenticateRequest(db, request(other.sessionToken))).toBeNull();
			const logs = (await db.query("SELECT metadata FROM audit_logs WHERE target_id=$1", [reader])).rows;
			expect(JSON.stringify(logs)).not.toContain(password);
			expect(JSON.stringify(logs)).not.toContain("new-strong-password");
		}));
	it("撤权立即生效；恢复机构上限不丢失角色定义；重复初始化不重授权限", () =>
		withFixture(async ({ db, org, manager, managerRole }) => {
			const previous = (
				await db.query<{ permission_key: string }>(
					"SELECT permission_key FROM organization_permissions WHERE organization_id=$1",
					[org],
				)
			).rows.map((r) => r.permission_key);
			await updateOrganizationPermissions(
				db,
				org,
				previous.filter((k) => k !== "members.manage"),
				admin.id,
			);
			expect((await resolveEffectiveAccess(db, manager.id, org, false)).permissions).not.toContain("members.manage");
			expect(
				(
					await db.query(
						"SELECT permission_key FROM role_permissions WHERE role_id=$1 AND permission_key='members.manage'",
						[managerRole],
					)
				).rows,
			).toHaveLength(1);
			await seedOrganizationRbac(db, org, admin.id);
			expect((await resolveEffectiveAccess(db, manager.id, org, false)).permissions).not.toContain("members.manage");
			await updateOrganizationPermissions(db, org, previous, admin.id);
			expect((await resolveEffectiveAccess(db, manager.id, org, false)).permissions).toContain("members.manage");
		}));
	it("跨机构角色和客户拒绝，角色重名/已分配删除为业务冲突", () =>
		withFixture(async ({ db, org, managerRole, readerRole }) => {
			const other = (await createOrganization(db, { name: "其他测试机构" }, admin.id)).id;
			await expect(createUser(db, input("cross-role", { roleIds: [readerRole] }), other, admin)).rejects.toMatchObject({
				status: 400,
			});
			await expect(
				createUser(db, input("cross-project", { roleIds: [], projectIds: ["A"] }), other, admin),
			).rejects.toMatchObject({ status: 400 });
			await expect(createRole(db, org, { name: "成员管理", permissionKeys: [] })).rejects.toMatchObject({
				status: 409,
			});
			await expect(deleteRole(db, org, managerRole)).rejects.toMatchObject({ status: 409 });
		}));
	it("封禁使成员无法登录，解封不恢复旧会话；超管不可被成员端修改", () =>
		withFixture(async ({ db, org, reader, manager }) => {
			const session = await login(db, response, { email: "reader@example.invalid", password, organizationId: org });
			await setOrganizationStatus(db, org, { status: "suspended", reason: "test" });
			expect(await authenticateRequest(db, request(session.sessionToken))).toBeNull();
			await expect(
				login(db, response, { email: "reader@example.invalid", password, organizationId: org }),
			).rejects.toThrow("封禁");
			await setOrganizationStatus(db, org, { status: "active" });
			expect(await authenticateRequest(db, request(session.sessionToken))).toBeNull();
			await expect(disableUser(db, admin.id, manager.id, "default", admin)).rejects.toThrow("系统超管");
			await expect(
				updateUserAccess(db, "default", admin.id, { roleIds: [], allProjects: false, projectIds: [] }),
			).rejects.toMatchObject({ status: 403 });
			expect(
				(await login(db, response, { email: "reader@example.invalid", password, organizationId: org })).user.id,
			).toBe(reader);
		}));
});
