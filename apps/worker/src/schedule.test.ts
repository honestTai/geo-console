import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { ensureProviderConfigs } from "./providers";
import {
	confirmProject,
	createBatch,
	defaultExecutionWindowMinutes,
	processDueSchedules,
	saveMonitoringSchedule,
} from "./service";
import { seedMeasurementModel } from "./test-support/measurement";

async function seed() {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await seedMeasurementModel(database);
	await ensureProviderConfigs(database);
	await database.query("UPDATE provider_configs SET enabled=true WHERE provider_id='kimi_api'");
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,aliases,status)
		 VALUES ('project','客户','https://brand.cn','brand.cn','成都','zh-CN','["客户"]'::jsonb,'active')`,
	);
	await database.query(
		`INSERT INTO prompts (id,project_id,question,intent,tags,approved,position)
		 VALUES ('prompt','project','问题 A？','购买','[]'::jsonb,true,0)`,
	);
	return database;
}

async function schedule(database: Awaited<ReturnType<typeof seed>>) {
	return (
		await database.query<{
			enabled: boolean;
			next_run_at: string | null;
			last_error: string | null;
			failure_count: number;
			last_batch_id: string | null;
		}>(
			"SELECT enabled,next_run_at,last_error,failure_count,last_batch_id FROM monitoring_schedules WHERE project_id='project'",
		)
	).rows[0];
}

const hoursFromNow = (value: string | null): number => (new Date(String(value)).getTime() - Date.now()) / 3_600_000;

describe("采样时间窗口", () => {
	it("三次以内按 0/4h/24h，超过三次在同一天内平均分布", () => {
		expect(defaultExecutionWindowMinutes(1)).toEqual([0]);
		expect(defaultExecutionWindowMinutes(3)).toEqual([0, 240, 1440]);
		expect(defaultExecutionWindowMinutes(5)).toEqual([0, 360, 720, 1080, 1440]);
		const ten = defaultExecutionWindowMinutes(10);
		expect(ten).toHaveLength(10);
		expect(ten[0]).toBe(0);
		expect(ten.at(-1)).toBe(1440);
	});

	it("基线创建的任务不会被拖到多天以后", async () => {
		const database = await seed();
		try {
			await createBatch(database, "project", { kind: "baseline", platforms: ["kimi_api"], repeats: 10 });
			const latest = (
				await database.query<{ hours: number }>(
					"SELECT extract(epoch FROM max(available_at)-now())/3600 AS hours FROM jobs WHERE type='capture'",
				)
			).rows[0];
			expect(Number(latest.hours)).toBeLessThanOrEqual(24.1);
		} finally {
			await database.close();
		}
	});
});

describe("周期监测", () => {
	it("修改周期后按新周期重算下一次运行时间；周期不变则保持", async () => {
		const database = await seed();
		try {
			const base = { enabled: true, platforms: ["kimi_api"], repeats: 1 };
			await saveMonitoringSchedule(database, "project", { ...base, frequencyDays: 7 });
			const weekly = await schedule(database);
			expect(hoursFromNow(weekly.next_run_at)).toBeGreaterThan(24 * 7 - 1);
			await saveMonitoringSchedule(database, "project", { ...base, frequencyDays: 1 });
			const daily = await schedule(database);
			expect(hoursFromNow(daily.next_run_at)).toBeGreaterThan(23);
			expect(hoursFromNow(daily.next_run_at)).toBeLessThan(25);
			await saveMonitoringSchedule(database, "project", { ...base, frequencyDays: 1, repeats: 3 });
			expect(String((await schedule(database)).next_run_at)).toBe(String(daily.next_run_at));
			await saveMonitoringSchedule(database, "project", { ...base, enabled: false, frequencyDays: 1 });
			expect((await schedule(database)).next_run_at).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("到期创建失败时记录原因、累计次数并一小时后重试，计划保持启用且不再静默", async () => {
		const database = await seed();
		try {
			await saveMonitoringSchedule(database, "project", {
				enabled: true,
				frequencyDays: 7,
				platforms: ["kimi_api"],
				repeats: 1,
			});
			// 范围被清空：到期时构造基线配置会失败。
			await database.query("UPDATE prompts SET approved=false WHERE project_id='project'");
			await database.query("UPDATE monitoring_schedules SET next_run_at=now()-interval '1 minute'");
			expect(await processDueSchedules(database)).toBe(0);
			const failed = await schedule(database);
			expect(failed.enabled).toBe(true);
			expect(failed.last_error).toContain("至少确认一个监测问题");
			expect(failed.failure_count).toBe(1);
			expect(hoursFromNow(failed.next_run_at)).toBeGreaterThan(0.9);
			expect(hoursFromNow(failed.next_run_at)).toBeLessThan(1.1);
			await database.query("UPDATE monitoring_schedules SET next_run_at=now()-interval '1 minute'");
			await processDueSchedules(database);
			expect((await schedule(database)).failure_count).toBe(2);
			// 成员修复范围后成功一次即清除失败记录。
			await database.query("UPDATE prompts SET approved=true WHERE project_id='project'");
			await database.query("UPDATE monitoring_schedules SET next_run_at=now()-interval '1 minute'");
			expect(await processDueSchedules(database)).toBe(1);
			const recovered = await schedule(database);
			expect(recovered).toMatchObject({ last_error: null, failure_count: 0 });
			expect(recovered.last_batch_id).toBeTruthy();
		} finally {
			await database.close();
		}
	});

	it("范围未变时复测最近基线；新增问题或修改范围后改为新建基线", async () => {
		const database = await seed();
		try {
			await saveMonitoringSchedule(database, "project", {
				enabled: true,
				frequencyDays: 7,
				platforms: ["kimi_api"],
				repeats: 1,
			});
			const baseline = await createBatch(database, "project", {
				kind: "baseline",
				platforms: ["kimi_api"],
				repeats: 1,
			});
			await database.query("UPDATE experiment_batches SET status='partial',completed_at=now() WHERE id=$1", [
				baseline.id,
			]);
			await database.query("UPDATE monitoring_schedules SET next_run_at=now()-interval '1 minute'");
			expect(await processDueSchedules(database)).toBe(1);
			const retest = (
				await database.query<{ id: string; kind: string; compare_to_batch_id: string | null }>(
					"SELECT id,kind,compare_to_batch_id FROM experiment_batches WHERE id<>$1",
					[baseline.id],
				)
			).rows[0];
			expect(retest).toMatchObject({ kind: "retest", compare_to_batch_id: baseline.id });
			await database.query("UPDATE experiment_batches SET status='complete',completed_at=now() WHERE id=$1", [
				retest.id,
			]);

			// 成员新增一个问题：旧基线不含它，复测会漏采，必须新建基线。
			await confirmProject(database, "project", {
				aliases: ["客户"],
				competitors: [],
				prompts: [
					{ id: "prompt", question: "问题 A？", intent: "购买", tags: [] },
					{ question: "新增问题 B？", intent: "购买", tags: [] },
				],
			});
			await database.query("UPDATE monitoring_schedules SET next_run_at=now()-interval '1 minute'");
			expect(await processDueSchedules(database)).toBe(1);
			const created = (
				await database.query<{ kind: string; config: { prompts: Array<{ question: string }> } }>(
					"SELECT kind,config FROM experiment_batches ORDER BY created_at DESC LIMIT 1",
				)
			).rows[0];
			expect(created.kind).toBe("baseline");
			expect(created.config.prompts.map((prompt) => prompt.question)).toEqual(["问题 A？", "新增问题 B？"]);
		} finally {
			await database.close();
		}
	});

	it("适配器升级后不能再按旧基线创建复测", async () => {
		const database = await seed();
		try {
			const baseline = await createBatch(database, "project", {
				kind: "baseline",
				platforms: ["kimi_api"],
				repeats: 1,
			});
			await database.query(
				`UPDATE experiment_batches SET config=jsonb_set(config,'{providers,0,adapterVersion}','"cloud-search.v0"'::jsonb) WHERE id=$1`,
				[baseline.id],
			);
			await expect(createBatch(database, "project", { kind: "retest", compareToBatchId: baseline.id })).rejects.toThrow(
				"适配器版本 cloud-search.v0 与当前 Worker",
			);
		} finally {
			await database.close();
		}
	});
});
