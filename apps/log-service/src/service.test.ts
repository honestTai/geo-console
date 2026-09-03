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

	it("页码分页返回总数并按时间倒序切页", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await ingestServiceLogs(database, {
				logs: Array.from({ length: 7 }, (_, index) => ({
					organizationId: "default",
					service: "api",
					level: index % 3 === 0 ? ("warn" as const) : ("info" as const),
					event: "http.request",
					message: `第 ${index + 1} 条`,
					occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
				})),
			});
			const first = await listServiceLogs(database, { organizationId: "default", page: 1, limit: 3 });
			expect(first).toMatchObject({ total: 7, page: 1, pageSize: 3, totalPages: 3 });
			expect(first.logs.map((log) => log.message)).toEqual(["第 7 条", "第 6 条", "第 5 条"]);
			const last = await listServiceLogs(database, { organizationId: "default", page: 3, limit: 3 });
			expect(last.logs.map((log) => log.message)).toEqual(["第 1 条"]);
			// 按级别筛选时总数跟随筛选条件
			const warns = await listServiceLogs(database, { organizationId: "default", level: "warn", page: 1, limit: 20 });
			expect(warns.total).toBe(3);
			expect(warns.counts.warn).toBe(3);
		} finally {
			await database.close();
		}
	});
});
