import { type Database, migrateDatabase, openMemoryDatabase } from "@geo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureProviderConfigs } from "./providers";
import { sweepTerminalLeases } from "./queue-recovery";
import { createBatch, createProject } from "./service";
import { seedMeasurementModel } from "./test-support/measurement";
import { cancelSession, executeSessionTurn, sendMessage } from "./workbench";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
async function seed() {
	vi.stubEnv("HROUTER_API_KEY", "test-only-key");
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await seedMeasurementModel(database);
	await database.query(
		`INSERT INTO projects(id,name,website_url,domain,region,language,aliases,status) VALUES('project','测试客户','https://example.com','example.com','CN','zh-CN','[]','active')`,
	);
	return database;
}
describe("审查问题回归", () => {
	it("中途入队失败时批次、语义运行和部分任务全部回滚", async () => {
		const database = await seed();
		try {
			await ensureProviderConfigs(database);
			await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
			await database.query(
				`INSERT INTO prompts(id,project_id,question,intent,tags,approved,position) VALUES('p1','project','题一','购买','[]',true,0),('p2','project','题二','购买','[]',true,1)`,
			);
			let inserts = 0;
			const wrap = (db: Database): Database => ({
				async query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]) {
					if (sql.includes("INSERT INTO jobs") && ++inserts === 2) throw new Error("test enqueue failure");
					return db.query<Row>(sql, params);
				},
				exec: (sql) => db.exec(sql),
				transaction: (work) => db.transaction((tx) => work(wrap(tx))),
				close: async () => {},
			});
			await expect(
				createBatch(wrap(database), "project", { kind: "quick_audit", platforms: ["kimi_api"] }),
			).rejects.toThrow("test enqueue failure");
			for (const table of ["experiment_batches", "semantic_parse_runs", "jobs"])
				expect((await database.query(`SELECT id FROM ${table}`)).rows).toEqual([]);
		} finally {
			await database.close();
		}
	});
	it("受限创建者获得新项目范围，不授予其他项目", async () => {
		const database = await seed();
		try {
			await database.query(
				`INSERT INTO users(id,email,display_name,role,password_hash,all_projects) VALUES('scoped','scope@example.com','测试用户','analyst','test-only',false)`,
			);
			const created = await createProject(
				database,
				{
					name: "新客户",
					websiteUrl: "https://example.org",
					region: "CN",
					language: "zh-CN",
					aliases: [],
					knownCompetitors: [],
				},
				"default",
				"scoped",
			);
			expect((await database.query("SELECT project_id FROM user_project_access WHERE user_id='scoped'")).rows).toEqual([
				{ project_id: created.id },
			]);
		} finally {
			await database.close();
		}
	});
	it("已取消的用户回合不会被重新执行，也不能继续发消息", async () => {
		const database = await seed();
		try {
			await database.query(
				`INSERT INTO agent_sessions(id,project_id,title,status,model) VALUES('session','project','测试会话','running','gpt-test')`,
			);
			await database.query(
				`INSERT INTO jobs(id,type,payload,status) VALUES('turn','agent_session_turn','{"sessionId":"session","trigger":"user","message":"继续"}','pending')`,
			);
			await cancelSession(database, "session");
			const fetcher = vi.fn();
			vi.stubGlobal("fetch", fetcher);
			await executeSessionTurn(database, "session", "user", "继续");
			await expect(sendMessage(database, "session", { message: "继续" })).rejects.toThrow("已终止");
			expect(fetcher).not.toHaveBeenCalled();
			expect((await database.query("SELECT status FROM jobs WHERE id='turn'")).rows[0].status).toBe("failed");
			expect((await database.query("SELECT status FROM agent_sessions WHERE id='session'")).rows[0].status).toBe(
				"failed",
			);
		} finally {
			await database.close();
		}
	});
	it("Agent/PDF 最后一次崩溃的租约都可进入失败终态", async () => {
		const database = await seed();
		try {
			for (const type of ["agent_draft", "agent_session_turn", "report_document", "report_pdf"])
				await database.query(
					`INSERT INTO jobs(id,type,payload,status,attempts,max_attempts,lease_expires_at) VALUES($1,$1,'{}','leased',2,2,now()-interval '1 minute')`,
					[type],
				);
			expect(await sweepTerminalLeases(database)).toBe(4);
			expect(await sweepTerminalLeases(database)).toBe(0);
			expect((await database.query("SELECT id FROM jobs WHERE status<>'failed'")).rows).toEqual([]);
		} finally {
			await database.close();
		}
	});
});
