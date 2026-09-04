import { randomUUID } from "node:crypto";
import { migrateDatabase, openDatabase } from "@geo/core";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { flushAgentLogs } from "./agent";
import {
	AGENT_JOB_CONCURRENCY,
	AGENT_JOB_POLL_MS,
	coordinateWorkbench,
	executeAgentDraft,
	recoverOrphanedAgentRuns,
	runOneAgentJob,
} from "./agent-jobs";

const database = await openDatabase();
await migrateDatabase(database);
await recoverOrphanedAgentRuns(database);
const owner = process.env.GEO_AGENT_EXECUTOR_ID?.trim() || `agent:${process.pid}:${randomUUID()}`;
const logger = new StructuredLogger("agent-worker");
let activeJobs = 0;
let lastCoordination = 0;

async function tick(): Promise<void> {
	if (activeJobs >= AGENT_JOB_CONCURRENCY) return;
	activeJobs += 1;
	try {
		if (Date.now() - lastCoordination >= 5_000) {
			lastCoordination = Date.now();
			await coordinateWorkbench(database);
		}
		await runOneAgentJob(database, owner, executeAgentDraft);
	} catch (error) {
		logger.error("worker.tick_failed", safeErrorMessage(error), { traceId: owner });
	} finally {
		activeJobs -= 1;
	}
}

const timer = setInterval(() => void tick(), AGENT_JOB_POLL_MS);
for (let index = 0; index < AGENT_JOB_CONCURRENCY; index += 1) void tick();
logger.info("service.started", "GEO Agent Worker 已启动", { traceId: owner });

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		clearInterval(timer);
		void Promise.all([logger.flush(), flushAgentLogs()]).finally(() => database.close().finally(() => process.exit(0)));
	});
