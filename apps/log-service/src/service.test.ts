import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { ingestServiceLogs, listServiceLogs, pruneOrganizationLogs, serviceLogsCsv } from "./service";

describe("standalone log service", () => {
	it("按租户检索、脱敏、导出并执行保留期清理", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query("INSERT INTO organizations (id,name) VALUES ('other','其他机构')");
			await ingestServiceLogs(database, {
				logs: [
					{
						organizationId: "default",
						service: "api",
						level: "error",
						event: "request.failed",
						message: "Bearer private-token 请求失败",
						traceId: "trace-1",
						metadata: { apiKey: "private-key", status: 500 },
						occurredAt: "2026-01-01T00:00:00.000Z",
					},
					{
						organizationId: "other",
						service: "api",
						level: "info",
						event: "request.complete",
						message: "其他机构日志",
					},
				],
			});
			const result = await listServiceLogs(database, { organizationId: "default", level: "error" });
			expect(result.logs).toHaveLength(1);
			expect(result.logs[0]?.message).not.toContain("private-token");
			expect(result.logs[0]?.metadata.apiKey).toBe("[REDACTED]");
			expect(await serviceLogsCsv(database, { organizationId: "default" })).toContain("trace-1");
			const pruned = await pruneOrganizationLogs(database, "default", 7);
			expect(pruned.deleted).toBe(1);
			expect((await listServiceLogs(database, { organizationId: "other" })).logs).toHaveLength(1);
		} finally {
			await database.close();
		}
	});
});
