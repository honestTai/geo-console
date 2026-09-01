import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { archiveLibraryQuestion, createLibraryQuestion, listLibraryQuestions } from "./knowledge-base";

describe("机构行业问题知识库", () => {
	it("只在当前机构和行业内复用，并保留归档记录", async () => {
		const database = openMemoryDatabase();
		try {
			await migrateDatabase(database);
			await database.query("INSERT INTO organizations (id,name) VALUES ('other','其他机构')");
			const current = await createLibraryQuestion(database, "default", null, {
				industry: "企业服务",
				question: "适合成长型企业的服务商有哪些？",
				intent: "购买决策",
				tags: ["选型"],
			});
			await createLibraryQuestion(database, "other", null, {
				industry: "企业服务",
				question: "其他租户的问题是什么？",
				intent: "调研",
			});
			expect(await listLibraryQuestions(database, "default", "企业服务")).toEqual([
				expect.objectContaining({ id: current.id, question: "适合成长型企业的服务商有哪些？" }),
			]);
			const otherQuestions = (await listLibraryQuestions(database, "other")) as Array<{ id: string }>;
			await expect(archiveLibraryQuestion(database, "default", otherQuestions[0]?.id ?? "missing")).rejects.toThrow(
				"不存在",
			);
			await archiveLibraryQuestion(database, "default", current.id);
			expect(await listLibraryQuestions(database, "default", "企业服务")).toEqual([]);
			const archived = await database.query<{ archived_at: string | null }>(
				"SELECT archived_at FROM prompt_library_questions WHERE id=$1",
				[current.id],
			);
			expect(archived.rows[0]?.archived_at).not.toBeNull();
		} finally {
			await database.close();
		}
	});
});
