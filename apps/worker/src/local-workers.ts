import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { executeAgentDraft, flushAgentLogs } from "./agent";
import { coordinateWorkbench, recoverOrphanedAgentRuns, runOneAgentJob } from "./agent-jobs";
import { flushCaptureLogs, startCloudRunner } from "./cloud-runner";
import { flushReportLogs, queueScheduledReportSnapshots, runOneReportJob } from "./report-snapshots";

export async function startLocalWorkers(database: Database): Promise<() => Promise<void>> {
	const logger = new StructuredLogger("local-worker-coordinator");
	await recoverOrphanedAgentRuns(database);
	const stopCapture = startCloudRunner(database);
	const agentOwner = `local-agent:${process.pid}:${randomUUID()}`;
	const reportOwner = `local-report:${process.pid}:${randomUUID()}`;
	let agentActive = false;
	let reportActive = false;
	let lastReportScan = 0;
	let lastCoordination = 0;
	const agentTick = async () => {
		if (agentActive) return;
		agentActive = true;
		try {
			if (Date.now() - lastCoordination >= 5_000) {
				lastCoordination = Date.now();
				await coordinateWorkbench(database);
			}
			await runOneAgentJob(database, agentOwner, executeAgentDraft);
		} catch (error) {
			logger.error("agent.tick_failed", safeErrorMessage(error), { traceId: agentOwner });
		} finally {
			agentActive = false;
		}
	};
	const reportTick = async () => {
		if (reportActive) return;
		reportActive = true;
		try {
			if (Date.now() - lastReportScan >= 15_000) {
				lastReportScan = Date.now();
				await queueScheduledReportSnapshots(database);
			}
			await runOneReportJob(database, reportOwner);
		} catch (error) {
			logger.error("report.tick_failed", safeErrorMessage(error), { traceId: reportOwner });
		} finally {
			reportActive = false;
		}
	};
	const agentTimer = setInterval(() => void agentTick(), 1_000);
	const reportTimer = setInterval(() => void reportTick(), 1_000);
	void agentTick();
	void reportTick();
	logger.info("service.started", "本机组合 Worker 已启动", {
		metadata: { capture: true, agent: true, report: true },
	});
	return async () => {
		clearInterval(agentTimer);
		clearInterval(reportTimer);
		stopCapture();
		await Promise.all([logger.flush(), flushCaptureLogs(), flushAgentLogs(), flushReportLogs()]);
	};
}
