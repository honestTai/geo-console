import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import {
	canAccessProject,
	canReadArtifact,
	createOrganization,
	requestResourceOrganization,
	requestResourceScope,
} from "./tenancy";

describe("多租户资源隔离", () => {
	it("解析资源归属并拒绝其他租户的证据对象", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const tenant = await createOrganization(database, { name: "租户二" });
			await database.query(
				`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,status)
				 VALUES ('tenant-project',$1,'租户客户','https://tenant.example','tenant.example','中国','zh-CN','active')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO report_snapshots
				 (id,organization_id,project_id,report_type,schema_version,title,payload,payload_hash,pdf_artifact_key,word_artifact_key)
				 VALUES ('tenant-report',$1,'tenant-project','quick_audit','test','报告','{}'::jsonb,'hash','reports/tenant.pdf','reports/tenant.docx')`,
				[tenant.id],
			);
			expect(await requestResourceOrganization(database, "/api/reports/tenant-report/pdf")).toBe(tenant.id);
			expect(await canReadArtifact(database, "default", "reports/tenant.pdf", true, [])).toBe(false);
			expect(await canReadArtifact(database, tenant.id, "reports/tenant.docx", true, [])).toBe(true);
			expect(await canReadArtifact(database, tenant.id, "reports/tenant.pdf", false, [])).toBe(false);
		} finally {
			await database.close();
		}
	});

	it("每一类带 id 的资源接口都能解析到机构与客户，供请求边界做机构-客户隔离", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			const tenant = await createOrganization(database, { name: "租户二" });
			await database.query(
				`INSERT INTO projects (id,organization_id,name,website_url,domain,region,language,status)
				 VALUES ('tenant-project',$1,'租户客户','https://tenant.example','tenant.example','中国','zh-CN','active')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO experiment_batches (id,project_id,kind,config,config_hash)
				 VALUES ('tenant-batch','tenant-project','baseline','{}'::jsonb,'hash')`,
			);
			await database.query(
				`INSERT INTO agent_runs (id,organization_id,project_id,batch_id,purpose,status,model,prompt_version)
				 VALUES ('tenant-run',$1,'tenant-project','tenant-batch','diagnosis','queued','gpt-5.5','v1')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO drift_alerts (id,project_id,batch_id,provider_id,metric,severity)
				 VALUES ('tenant-alert','tenant-project','tenant-batch','kimi_api','brandMentionRate','warning')`,
			);
			await database.query(
				`INSERT INTO report_snapshots (id,organization_id,project_id,report_type,schema_version,title,payload,payload_hash)
				 VALUES ('tenant-report',$1,'tenant-project','quick_audit','test','报告','{}'::jsonb,'hash')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO report_shares (id,report_id,token_hash,expires_at)
				 VALUES ('tenant-share','tenant-report','token-hash',now()+interval '1 day')`,
			);
			await database.query(
				`INSERT INTO agent_sessions (id,organization_id,project_id,title) VALUES ('tenant-session',$1,'tenant-project','会话')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO optimization_articles (id,organization_id,project_id,recommendation_title,title)
				 VALUES ('tenant-article',$1,'tenant-project','建议','文章')`,
				[tenant.id],
			);
			await database.query(
				`INSERT INTO remediation_tasks (id,project_id,title,detail,priority,expected_metric,acceptance_criteria)
				 VALUES ('tenant-task','tenant-project','任务','详情','high','提及率','验收')`,
			);
			const paths = [
				"/api/projects/tenant-project",
				"/api/projects/tenant-project/attribution",
				"/api/batches/tenant-batch/report",
				"/api/agent-runs/tenant-run/approve",
				"/api/drift-alerts/tenant-alert/acknowledge",
				"/api/reports/tenant-report/export.csv",
				"/api/report-shares/tenant-share",
				"/api/workbench/sessions/tenant-session/events",
				"/api/articles/tenant-article/regenerate",
				"/api/tasks/tenant-task/verify",
			];
			for (const path of paths)
				expect(await requestResourceScope(database, path), path).toEqual({
					organizationId: tenant.id,
					projectId: "tenant-project",
				});
			// 不存在的资源解析为 null，请求边界按 404 处理，不泄露其他机构是否存在该 id
			expect(await requestResourceScope(database, "/api/projects/missing")).toBeNull();
			// 机构内还可以限定客户范围；超管与“全部客户”成员不受限
			expect(canAccessProject("tenant-project", true, [])).toBe(true);
			expect(canAccessProject("tenant-project", false, ["tenant-project"])).toBe(true);
			expect(canAccessProject("tenant-project", false, ["other-project"])).toBe(false);
		} finally {
			await database.close();
		}
	});
});
