import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { safeErrorMessage } from "@geo/logging";
import {
	finalizeMeasurements,
	measurementLogger,
	queueSemanticCaptures,
	recordMeasurementDrift,
	runOneSemanticJob,
} from "./measurement";
import { sweepTerminalLeases } from "./queue-recovery";

export function startSemanticRuntime(database: Database): () => Promise<void> {
	const owner = `semantic:${process.pid}:${randomUUID()}`;
	let stopped = false;
	let coordinating = false;
	const jobs = new Set<Promise<unknown>>();
	const coordinate = async () => {
		if (stopped || coordinating) return;
		coordinating = true;
		try {
			await sweepTerminalLeases(database);
			await queueSemanticCaptures(database);
			await finalizeMeasurements(database);
			await recordMeasurementDrift(database);
		} catch (error) {
			measurementLogger.error("semantic.coordinate_failed", safeErrorMessage(error));
		} finally {
			coordinating = false;
		}
	};
	const tick = () => {
		if (stopped || jobs.size >= 2) return;
		const job = runOneSemanticJob(database, owner)
			.catch((e) => measurementLogger.error("semantic.tick_failed", safeErrorMessage(e)))
			.finally(() => jobs.delete(job));
		jobs.add(job);
	};
	const timer = setInterval(tick, 500);
	const coordinator = setInterval(() => void coordinate(), 5_000);
	void coordinate();
	return async () => {
		stopped = true;
		clearInterval(timer);
		clearInterval(coordinator);
		await Promise.allSettled([...jobs]);
		while (coordinating) await new Promise((resolve) => setTimeout(resolve, 50));
		await measurementLogger.flush();
	};
}
