import { randomUUID } from "node:crypto";
import { migrateDatabase, openDatabase } from "@geo/core";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { checkObjectStore } from "./object-store";
import { flushReportLogs, queueScheduledReportSnapshots, runOneReportJob } from "./report-snapshots";

const database = await openDatabase();
await migrateDatabase(database);
await checkObjectStore();
const owner = process.env.GEO_REPORT_EXECUTOR_ID?.trim() || `report:${process.pid}:${randomUUID()}`;
const logger = new StructuredLogger("report-worker");
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
		logger.error("worker.tick_failed", safeErrorMessage(error), { traceId: owner });
	} finally {
		active = false;
	}
}
const timer = setInterval(() => void tick(), 1_000);
void tick();
logger.info("service.started", "GEO Report Worker 已启动", { traceId: owner });

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		clearInterval(timer);
		void Promise.all([logger.flush(), flushReportLogs()]).finally(() =>
			database.close().finally(() => process.exit(0)),
		);
	});
