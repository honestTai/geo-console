import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceManifestSchema } from "./desktop-workspace";
import { openDesktopDatabase, openMemorySqliteDatabase } from "./sqlite";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "geo-sqlite-test-"));
	roots.push(root);
	return root;
}

describe("fresh desktop SQLite contract", () => {
	it("starts empty, enforces enums, and never needs migrations", async () => {
		const db = openMemorySqliteDatabase();
		try {
			expect((await db.query("SELECT count(*) AS count FROM projects")).rows[0].count).toBe(0);
			await expect(
				db.query("INSERT INTO projects(id,name,region,language,status) VALUES('p','test','test','en','not-a-status')"),
			).rejects.toThrow();
			expect((await db.query("PRAGMA user_version")).rows[0].user_version).toBe(1);
		} finally {
			await db.close();
		}
	});
	it("serializes concurrent transactions and rolls back atomically", async () => {
		const db = openMemorySqliteDatabase();
		try {
			await expect(
				db.transaction(async (tx) => {
					await tx.query("INSERT INTO settings(key,value) VALUES('rollback','{}')");
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			expect((await db.query("SELECT * FROM settings WHERE key='rollback'")).rows).toEqual([]);
			await db.query("INSERT INTO settings(key,value) VALUES('counter','0')");
			await Promise.all(
				Array.from({ length: 12 }, () =>
					db.transaction(async (tx) => {
						const value = (await tx.query<{ value: number }>("SELECT value FROM settings WHERE key='counter'")).rows[0]
							.value;
						await new Promise((resolve) => setTimeout(resolve, 1));
						await tx.query("UPDATE settings SET value=$1 WHERE key='counter'", [JSON.stringify(value + 1)]);
					}),
				),
			);
			expect((await db.query("SELECT value FROM settings WHERE key='counter'")).rows[0].value).toBe(12);
		} finally {
			await db.close();
		}
	});
	it("persists real SQLite and restores a WAL-consistent snapshot without overwrite", async () => {
		const root = await directory();
		const file = join(root, "workspace.sqlite");
		let db = await openDesktopDatabase(file);
		await db.query("INSERT INTO settings(key,value) VALUES('persist',$1)", [{ answer: 42 }]);
		const snapshot = await db.snapshot();
		await db.close();
		expect((await readFile(file)).subarray(0, 16).toString()).toBe("SQLite format 3\0");
		db = await openDesktopDatabase(file);
		expect((await db.query("SELECT value FROM settings WHERE key='persist'")).rows[0].value).toEqual({ answer: 42 });
		await db.close();
		const restored = await openDesktopDatabase(join(root, "restored.sqlite"), snapshot);
		expect((await restored.query("SELECT value FROM settings WHERE key='persist'")).rows[0].value).toEqual({
			answer: 42,
		});
		await restored.close();
		await expect(openDesktopDatabase(file, snapshot)).rejects.toThrow();
	});
	it("rejects old, foreign, or future databases instead of migrating them", async () => {
		const root = await directory();
		const file = join(root, "workspace.sqlite");
		await expect(openDesktopDatabase(file, new Blob(["old postgres archive"]))).rejects.toThrow("旧数据库");
		const other = new DatabaseSync(file);
		other.exec("PRAGMA user_version=99");
		other.close();
		const before = await readFile(file);
		await expect(openDesktopDatabase(file)).rejects.toThrow("不会迁移");
		expect(await readFile(file)).toEqual(before);
		await writeFile(join(root, "bad.sqlite"), "not a database");
		await expect(openDesktopDatabase(join(root, "bad.sqlite"))).rejects.toThrow();
	});
	it.each([
		"../master-key",
		"artifacts/../master-key",
		"artifacts/a\\b",
		"artifacts/NUL.txt",
		"artifacts/file.",
		"artifacts/a:b",
		"artifacts/\u0000",
	])("rejects unsafe cross-platform manifest path %s", (path) => {
		expect(
			workspaceManifestSchema.safeParse({
				format: "geo.desktop-workspace.sqlite.v1",
				files: [
					{ path: "workspace.sqlite", size: 0, chunks: [] },
					{ path, size: 0, chunks: [] },
				],
			}).success,
		).toBe(false);
	});
});
