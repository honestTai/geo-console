import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it, vi } from "vitest";
import { runOneAgentJob } from "./agent-jobs";

async function seedAgentJob() {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,status)
		 VALUES ('project','测试客户','https://brand.example','brand.example','成都','zh-CN','active')`,
	);
	await database.query(
		`INSERT INTO agent_runs (id,project_id,purpose,status,model,prompt_version)
		 VALUES ('run','project','report_narrative','queued','gpt-test','test')`,
	);
	await database.query(
		`INSERT INTO jobs (id,type,payload,status,max_attempts,available_at)
		 VALUES ('job','agent_draft','{"runId":"run","targetTaskId":null}'::jsonb,'pending',2,now())`,
	);
	return database;
}

describe("Agent 任务队列", () => {
	it("领取任务并在执行成功后完成租约", async () => {
		const database = await seedAgentJob();
		try {
			const runner = vi.fn(async () => undefined);
			expect(await runOneAgentJob(database, "worker", runner)).toBe(true);
			expect(runner).toHaveBeenCalledWith(database, "run", null);
			const job = (await database.query<{ status: string }>("SELECT status FROM jobs WHERE id='job'")).rows[0];
			expect(job.status).toBe("complete");
		} finally {
			await database.close();
		}
	});

	it("失败后排队重试，第二次失败进入可见终态", async () => {
		const database = await seedAgentJob();
		try {
			const runner = vi.fn(async () => {
				throw new Error("上游模型暂时不可用");
			});
			await runOneAgentJob(database, "worker", runner);
			let run = (
				await database.query<{ status: string; error_message: string }>(
					"SELECT status,error_message FROM agent_runs WHERE id='run'",
				)
			).rows[0];
			expect(run.status).toBe("queued");
			expect(run.error_message).toContain("30 秒后自动重试");

			await database.query("UPDATE jobs SET available_at=now() WHERE id='job'");
			await runOneAgentJob(database, "worker", runner);
			const job = (await database.query<{ status: string }>("SELECT status FROM jobs WHERE id='job'")).rows[0];
			run = (
				await database.query<{ status: string; error_message: string }>(
					"SELECT status,error_message FROM agent_runs WHERE id='run'",
				)
			).rows[0];
			expect(job.status).toBe("failed");
			expect(run.status).toBe("failed");
		} finally {
			await database.close();
		}
	});

	it("交互会话优先于更早排队的后台草稿", async () => {
		const database = await seedAgentJob();
		try {
			await database.query(
				`INSERT INTO agent_sessions (id,organization_id,project_id,title,status)
				 VALUES ('session','default','project','新问题','running')`,
			);
			await database.query(
				`INSERT INTO jobs (id,type,payload,status,max_attempts,available_at,created_at)
				 VALUES ('turn','agent_session_turn','{"sessionId":"session","trigger":"user","message":"你好"}'::jsonb,'pending',2,now(),now())`,
			);
			const draft = vi.fn(async () => undefined);
			const sessionTurn = vi.fn(async () => undefined);
			expect(await runOneAgentJob(database, "worker", { draft, sessionTurn })).toBe(true);
			expect(sessionTurn).toHaveBeenCalledWith(database, "session", "user", "你好");
			expect(draft).not.toHaveBeenCalled();
			const jobs = await database.query<{ id: string; status: string }>("SELECT id,status FROM jobs ORDER BY id");
			expect(jobs.rows).toEqual([
				{ id: "job", status: "pending" },
				{ id: "turn", status: "complete" },
			]);
		} finally {
			await database.close();
		}
	});
});
