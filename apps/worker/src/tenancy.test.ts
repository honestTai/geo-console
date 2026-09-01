import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { canReadArtifact, createOrganization, requestResourceOrganization } from "./tenancy";

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
});
