import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { captureProgress, settleBlockedCaptureJobs } from "./capture-progress";
import { refreshBatchStatus } from "./service";

describe("batch-local quota circuit breaker", () => {
	it("stops future jobs only for the failed batch/provider, preserves evidence and config, and ignores semantic jobs when settling capture", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query("INSERT INTO projects(id,name,region,language) VALUES('p','测试客户','测试地区','zh-CN')");
			await db.query(
				"INSERT INTO prompts(id,project_id,question,intent,position) VALUES('q','p','测试问题是什么？','购买',0)",
			);
			await db.query(
				"INSERT INTO experiment_batches(id,project_id,kind,status,config,config_hash) VALUES('b','p','baseline','running','{}','unchanged'),('other','p','baseline','running','{}','other')",
			);
			await db.query(`INSERT INTO jobs(id,type,payload,status,available_at,lease_owner,lease_expires_at) VALUES
			 ('observed','capture','{"batchId":"b","platform":"deepseek_api"}','complete',now(),NULL,NULL),
			 ('future','capture','{"batchId":"b","platform":"deepseek_api"}','pending',now()+interval '24 hours',NULL,NULL),
			 ('live','capture','{"batchId":"b","platform":"deepseek_api"}','leased',now(),'live-worker',now()+interval '2 minutes'),
			 ('other-provider','capture','{"batchId":"b","platform":"kimi_api"}','pending',now(),NULL,NULL),
			 ('other-batch','capture','{"batchId":"other","platform":"deepseek_api"}','pending',now(),NULL,NULL),
			 ('semantic','semantic_parse','{"batchId":"b"}','pending',now(),NULL,NULL)`);
			await db.query(`INSERT INTO query_captures(id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,adapter_version,capture_mode,failure_code,failure_message,captured_at)
			 VALUES('c','observed','b','p','q','deepseek_api',1,'failed','cloud-search.v2','llm_search_api','provider_error','供应商请求失败（HTTP 402）',now())`);
			const before = (await db.query("SELECT * FROM query_captures")).rows;
			expect(await settleBlockedCaptureJobs(db)).toEqual(["b"]);
			expect(await settleBlockedCaptureJobs(db)).toEqual([]);
			const jobs = (await db.query<{ id: string; status: string }>("SELECT id,status FROM jobs")).rows;
			expect(Object.fromEntries(jobs.map((j) => [j.id, j.status]))).toMatchObject({
				future: "failed",
				live: "leased",
				"other-provider": "pending",
				"other-batch": "pending",
				semantic: "pending",
			});
			expect(await captureProgress(db, "b")).toMatchObject({
				pending: 1,
				active: 1,
				completed: 1,
				failed: 1,
				blockedProviders: ["deepseek_api"],
			});
			await refreshBatchStatus(db, "b");
			expect((await db.query("SELECT status FROM experiment_batches WHERE id='b'")).rows[0]).toMatchObject({
				status: "running",
			});
			await db.query("UPDATE jobs SET status='complete' WHERE id IN ('live','other-provider')");
			await refreshBatchStatus(db, "b");
			expect(
				(await db.query("SELECT status,config_hash,config FROM experiment_batches WHERE id='b'")).rows[0],
			).toMatchObject({ status: "partial", config_hash: "unchanged", config: {} });
			expect((await db.query("SELECT * FROM query_captures")).rows).toEqual(before);
		} finally {
			await db.close();
		}
	}, 20_000);
});
