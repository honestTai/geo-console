import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { runOneCloudCapture, sweepExpiredCaptureJobs } from "./cloud-runner";

const config = {
	project: { name: "客户", domain: "brand.cn", region: "成都", language: "zh-CN", aliases: ["客户"] },
	competitors: [],
	prompts: [{ id: "prompt", question: "问题？", intent: "购买", tags: [] }],
	platforms: ["kimi_api"],
	repeats: 1,
	runnerVersion: "cloud-runner.v1",
	samplingMode: "quick",
	executionWindows: ["PT0M"],
	providers: [
		{
			id: "kimi_api",
			endpoint: "https://api.moonshot.ai/v1",
			model: "kimi-k3",
			protocol: "moonshot-chat",
			searchToolVersion: "web-search",
			searchStrategy: {},
			// 与当前 Worker 不一致：任务不会调用真实供应商，而是以 protocol_changed 结果直接进入落库路径。
			adapterVersion: "legacy.v0",
		},
	],
};

async function seed(job: { promptId: string; status: "pending" | "leased"; attempts: number; leaseExpired?: boolean }) {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
		 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
	);
	await database.query(
		`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
		 VALUES ('prompt','project','问题？','购买','[]'::jsonb,true,0)`,
	);
	await database.query(
		`INSERT INTO experiment_batches (id,project_id,kind,status,config,config_hash,started_at)
		 VALUES ('batch','project','quick_audit','running',$1::jsonb,'hash',now())`,
		[JSON.stringify(config)],
	);
	await database.query(
		`INSERT INTO jobs (id,type,payload,status,attempts,max_attempts,available_at,lease_owner,lease_expires_at)
		 VALUES ('job','capture',$1::jsonb,$2::job_status,$3,3,now(),$4,$5)`,
		[
			JSON.stringify({
				projectId: "project",
				batchId: "batch",
				promptId: job.promptId,
				prompt: "问题？",
				platform: "kimi_api",
				attempt: 1,
				region: "成都",
				locale: "zh-CN",
				brands: [],
			}),
			job.status,
			job.attempts,
			job.status === "leased" ? "dead-worker" : null,
			job.status === "leased" ? new Date(Date.now() - (job.leaseExpired ? 60_000 : -60_000)).toISOString() : null,
		],
	);
	return database;
}

describe("Capture 任务失败收敛", () => {
	it("执行抛错时把任务标为失败并让批次收敛为 partial，而不是停在过期的 leased", async () => {
		// 引用不存在的问题：证据落库时违反外键，是“任务执行到一半抛错”的确定性重现。
		const database = await seed({ promptId: "missing-prompt", status: "pending", attempts: 2 });
		try {
			await expect(runOneCloudCapture(database)).rejects.toThrow();
			const job = (
				await database.query<{ status: string; attempts: number; lease_owner: string | null; last_error: string }>(
					"SELECT status,attempts,lease_owner,last_error FROM jobs WHERE id='job'",
				)
			).rows[0];
			expect(job).toMatchObject({ status: "failed", attempts: 3, lease_owner: null });
			expect(job.last_error).toBeTruthy();
			const batch = (await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id='batch'"))
				.rows[0];
			expect(batch.status).toBe("partial");
		} finally {
			await database.close();
		}
	});

	it("未用尽重试时重新排队，批次继续等待", async () => {
		const database = await seed({ promptId: "missing-prompt", status: "pending", attempts: 0 });
		try {
			await expect(runOneCloudCapture(database)).rejects.toThrow();
			const job = (
				await database.query<{ status: string; attempts: number }>("SELECT status,attempts FROM jobs WHERE id='job'")
			).rows[0];
			expect(job).toMatchObject({ status: "pending", attempts: 1 });
			const batch = (await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id='batch'"))
				.rows[0];
			expect(batch.status).toBe("running");
		} finally {
			await database.close();
		}
	});

	it("定期清扫把进程崩溃留下的过期且用尽重试的租约标为失败并刷新批次", async () => {
		const database = await seed({ promptId: "prompt", status: "leased", attempts: 3, leaseExpired: true });
		try {
			expect(await sweepExpiredCaptureJobs(database)).toBe(1);
			const job = (
				await database.query<{ status: string; last_error: string }>(
					"SELECT status,last_error FROM jobs WHERE id='job'",
				)
			).rows[0];
			expect(job.status).toBe("failed");
			expect(job.last_error).toContain("租约过期");
			const batch = (await database.query<{ status: string }>("SELECT status FROM experiment_batches WHERE id='batch'"))
				.rows[0];
			expect(batch.status).toBe("partial");
			expect(await sweepExpiredCaptureJobs(database)).toBe(0);
		} finally {
			await database.close();
		}
	});

	it("租约未过期或还能重试的任务不被清扫", async () => {
		const database = await seed({ promptId: "prompt", status: "leased", attempts: 3, leaseExpired: false });
		try {
			expect(await sweepExpiredCaptureJobs(database)).toBe(0);
			await database.query("UPDATE jobs SET attempts=1,lease_expires_at=now()-interval '1 minute' WHERE id='job'");
			expect(await sweepExpiredCaptureJobs(database)).toBe(0);
			expect((await database.query<{ status: string }>("SELECT status FROM jobs WHERE id='job'")).rows[0].status).toBe(
				"leased",
			);
		} finally {
			await database.close();
		}
	});
});
