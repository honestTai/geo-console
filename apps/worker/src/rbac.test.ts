import type { ServerResponse } from "node:http";
import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { createUser, login } from "./auth";
import {
	AccessDeniedError,
	authorizeDynamicRequest,
	createRole,
	getDynamicNavigation,
	listRoles,
	resolveEffectiveAccess,
	updateOrganizationPermissions,
	updateRole,
	updateUserAccess,
} from "./rbac";
import { createOrganization, setOrganizationStatus } from "./tenancy";

const firstPage = { page: 1, pageSize: 20, offset: 0, search: null };

describe("动态分层 RBAC", () => {
	it("按机构上限、角色并集和用户客户范围计算最终权限", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const organization = await createOrganization(database, { name: "动态权限机构" });
			await database.query(
				`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,status)
				 VALUES ('project-a',$1,'客户 A','https://a.example','a.example','中国','zh-CN','active'),
				 ('project-b',$1,'客户 B','https://b.example','b.example','中国','zh-CN','active')`,
				[organization.id],
			);
			const role = await createRole(database, organization.id, {
				name: "监测专员",
				description: "仅运行监测",
				permissionKeys: ["page.monitor", "monitor.run"],
			});
			const user = await createUser(
				database,
				{
					email: "operator@example.com",
					displayName: "监测专员",
					password: "a-strong-user-password",
					roleIds: [role.id],
					allProjects: false,
					projectIds: ["project-a"],
				},
				organization.id,
			);
			const access = await resolveEffectiveAccess(database, user.id, organization.id, false);
			expect(access.permissions).toEqual(["monitor.run", "page.monitor"]);
			expect(access.allProjects).toBe(false);
			expect(access.projectIds).toEqual(["project-a"]);
			await authorizeDynamicRequest(database, access.permissions, false, "POST", "/api/projects/project-a/batches");
			await expect(
				authorizeDynamicRequest(database, access.permissions, false, "POST", "/api/projects/project-a/audit"),
			).rejects.toBeInstanceOf(AccessDeniedError);
			await updateOrganizationPermissions(database, organization.id, ["page.monitor"], null);
			expect((await resolveEffectiveAccess(database, user.id, organization.id, false)).permissions).toEqual([
				"page.monitor",
			]);
			await updateUserAccess(database, organization.id, user.id, {
				roleIds: [role.id],
				allProjects: true,
				projectIds: [],
			});
			expect((await resolveEffectiveAccess(database, user.id, organization.id, false)).allProjects).toBe(true);
		} finally {
			await database.close();
		}
	});

	it("导航、角色和机构状态均由数据库记录驱动", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const organization = await createOrganization(database, { name: "机构二" });
			await createUser(
				database,
				{ email: "member@example.com", displayName: "成员", password: "a-strong-member-password" },
				organization.id,
			);
			const roles = await listRoles(database, organization.id, firstPage);
			expect(roles.total).toBe(3);
			const role = roles.items.find((item) => item.name === "只读成员");
			expect(role).toBeTruthy();
			await updateRole(database, organization.id, String(role?.id), {
				name: "观察员",
				description: "动态改名",
				permissionKeys: ["page.overview"],
			});
			const navigation = await getDynamicNavigation(database, ["page.overview"], false, false);
			expect(navigation.items).toEqual([expect.objectContaining({ navigation_key: "overview" })]);
			await setOrganizationStatus(database, organization.id, { status: "suspended", reason: "合同到期" });
			const status = await database.query<{ suspended_at: string | null; suspended_reason: string | null }>(
				"SELECT suspended_at,suspended_reason FROM organizations WHERE id=$1",
				[organization.id],
			);
			expect(status.rows[0]?.suspended_at).not.toBeNull();
			expect(status.rows[0]?.suspended_reason).toBe("合同到期");
			await expect(
				login(database, { setHeader() {} } as unknown as ServerResponse, {
					email: "member@example.com",
					password: "a-strong-member-password",
					organizationId: organization.id,
				}),
			).rejects.toThrow("机构已被封禁");
		} finally {
			await database.close();
		}
	});

	it("数据库最多允许一个系统超管", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				`INSERT INTO users (id,organization_id,email,display_name,role,is_super_admin,password_hash)
				 VALUES ('super-one','default','one@example.com','一号超管','admin',true,'hash')`,
			);
			await expect(
				database.query(
					`INSERT INTO users (id,organization_id,email,display_name,role,is_super_admin,password_hash)
					 VALUES ('super-two','default','two@example.com','二号超管','admin',true,'hash')`,
				),
			).rejects.toThrow();
		} finally {
			await database.close();
		}
	});

	it("为全部受保护页面和接口登记动态策略", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const cases: Array<[string, string, string]> = [
				["page.overview", "GET", "/api/projects"],
				["page.overview", "GET", "/api/projects/project/trends/batch"],
				["project.create", "POST", "/api/projects"],
				["project.onboard", "POST", "/api/projects/project/confirm"],
				["page.monitor", "GET", "/api/batches/batch"],
				["page.monitor", "GET", "/api/projects/project/drift-alerts"],
				["monitor.run", "POST", "/api/projects/project/batches"],
				["monitor.schedule", "PUT", "/api/projects/project/monitoring-schedule"],
				["page.evidence", "GET", "/api/batches/batch"],
				["audit.run", "POST", "/api/projects/project/audit"],
				["diagnosis.run", "POST", "/api/batches/batch/diagnose"],
				["agent.run", "POST", "/api/batches/batch/agent"],
				["page.diagnosis", "GET", "/api/projects/project/agent-runs"],
				["agent.approve", "POST", "/api/agent-runs/run/approve"],
				["remediation.manage", "POST", "/api/projects/project/tasks/from-findings"],
				["remediation.manage", "PATCH", "/api/tasks/task"],
				["remediation.manage", "POST", "/api/tasks/task/verify"],
				["page.attribution", "GET", "/api/projects/project/attribution"],
				["attribution.import", "POST", "/api/projects/project/attribution/import"],
				["page.report", "GET", "/api/projects/project/reports"],
				["page.report", "GET", "/api/batches/batch/report"],
				["page.report", "GET", "/api/reports/report/shares"],
				["report.generate", "POST", "/api/batches/batch/report-workflow"],
				["report.generate", "POST", "/api/reports/report/pdf"],
				["report.share", "POST", "/api/reports/report/shares"],
				["report.share", "DELETE", "/api/report-shares/share"],
				["page.knowledge", "GET", "/api/knowledge/questions"],
				["knowledge.manage", "DELETE", "/api/knowledge/questions/question"],
				["page.settings", "GET", "/api/settings/hrouter/models"],
				["settings.manage", "PUT", "/api/settings/providers/deepseek_api"],
				["settings.manage", "POST", "/api/settings/providers/deepseek_api/test"],
				["page.members", "GET", "/api/users"],
				["page.members", "GET", "/api/rbac/roles"],
				["members.manage", "DELETE", "/api/users/user"],
				["page.audit_logs", "GET", "/api/audit-logs"],
				["page.service_logs", "GET", "/api/service-logs"],
				["logs.export", "GET", "/api/service-logs/export.csv"],
				["logs.retention", "POST", "/api/service-logs/retention"],
				["page.rbac", "GET", "/api/rbac/catalog"],
				["rbac.manage", "PUT", "/api/users/user/access"],
				["page.organizations", "GET", "/api/organizations"],
				["organization.manage", "PUT", "/api/organizations/organization/status"],
			];
			for (const [permission, method, path] of cases)
				await expect(authorizeDynamicRequest(database, [permission], false, method, path)).resolves.toBeUndefined();
			await expect(
				authorizeDynamicRequest(database, ["page.overview"], false, "POST", "/api/unregistered"),
			).rejects.toBeInstanceOf(AccessDeniedError);
		} finally {
			await database.close();
		}
	});
});
