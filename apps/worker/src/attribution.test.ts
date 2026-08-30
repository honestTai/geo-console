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
			const imported = await importAttributionCsv(database, "project", input);
			expect(imported.events).toBe(2);
			const result = await getAttribution(database, "project");
			expect(result.summary).toHaveLength(2);
			await expect(importAttributionCsv(database, "project", input)).rejects.toThrow("已经导入过");
		} finally {
			await database.close();
		}
	});
});
