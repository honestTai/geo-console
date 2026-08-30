import { randomUUID } from "node:crypto";
import { migrateDatabase, openDatabase } from "@geo/core";
import { checkObjectStore } from "./object-store";
import { queueScheduledReportSnapshots, runOneReportJob } from "./report-snapshots";

const database = await openDatabase();
await migrateDatabase(database);
await checkObjectStore();
const owner = process.env.GEO_REPORT_EXECUTOR_ID?.trim() || `report:${process.pid}:${randomUUID()}`;
let active = false;
let lastScheduleScan = 0;
async function tick(): Promise<void> {
	if (active) return;
	active = true;
	try {
		if (Date.now() - lastScheduleScan >= 15_000) {
			lastScheduleScan = Date.now();
			await queueScheduledReportSnapshots(database);
		}
		await runOneReportJob(database, owner);
	} catch (error) {
		console.error("报告任务执行失败", error);
	} finally {
		active = false;
	}
}
const timer = setInterval(() => void tick(), 1_000);
void tick();
console.log(`GEO Report Worker 已启动：${owner}`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		clearInterval(timer);
		void database.close().finally(() => process.exit(0));
	});
