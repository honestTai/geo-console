import { randomUUID } from "node:crypto";
import { migrateDatabase, openDatabase } from "@geo/core";
import { executeAgentDraft, recoverOrphanedAgentRuns, runOneAgentJob } from "./agent-jobs";

const database = await openDatabase();
await migrateDatabase(database);
await recoverOrphanedAgentRuns(database);
const owner = process.env.GEO_AGENT_EXECUTOR_ID?.trim() || `agent:${process.pid}:${randomUUID()}`;
let active = false;

async function tick(): Promise<void> {
	if (active) return;
	active = true;
	try {
		await runOneAgentJob(database, owner, executeAgentDraft);
	} catch (error) {
		console.error("Agent 任务执行失败", error);
	} finally {
		active = false;
	}
}

const timer = setInterval(() => void tick(), 1_000);
void tick();
console.log(`GEO Agent Worker 已启动：${owner}`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		clearInterval(timer);
		void database.close().finally(() => process.exit(0));
	});
