import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { getAttribution, importAttributionCsv } from "./attribution";

describe("真实归因 CSV", () => {
	it("解析常见宽表并阻止相同文件重复计数", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query(
				"INSERT INTO projects (id,name,website_url,domain,region,language,status) VALUES ('project','客户','https://example.com','example.com','成都','zh-CN','active')",
			);
			const input = {
				sourceType: "ga4",
				fileName: "ga4.csv",
				csv: "date,landing page,sessions,users\n20260829,https://example.com/a,12,8\n",
			};
			await expect(
				importAttributionCsv(database, "project", { ...input, csv: "date,sessions\n2026-02-31,1\n" }),
			).rejects.toMatchObject({ status: 400 });
			expect((await database.query("SELECT id FROM attribution_imports")).rows).toHaveLength(0);
			const imported = await importAttributionCsv(database, "project", input);
			expect(imported.events).toBe(2);
			const result = await getAttribution(database, "project", { page: 1, pageSize: 20, offset: 0, search: null });
			expect(result.summary).toHaveLength(2);
			await expect(importAttributionCsv(database, "project", input)).rejects.toThrow("已经导入过");
			const daily = await importAttributionCsv(database, "project", {
				sourceType: "gsc",
				fileName: "gsc.csv",
				csv: "日期,点击次数\n2026-08-29,5\n2026/8/30,6\n2026-08-30T09:30:00+08:00,7\n",
			});
			expect(daily.events).toBe(3);
			const stored = await database.query<{ observed_at: Date | string }>(
				"SELECT observed_at FROM attribution_events WHERE source_type='gsc' ORDER BY observed_at",
			);
			expect(stored.rows.map((row) => new Date(row.observed_at).toISOString())).toEqual([
				"2026-08-28T16:00:00.000Z",
				"2026-08-29T16:00:00.000Z",
				"2026-08-30T01:30:00.000Z",
			]);
		} finally {
			await database.close();
		}
	});
});
