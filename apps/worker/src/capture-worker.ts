import { migrateDatabase, openDatabase } from "@geo/core";
import { StructuredLogger } from "@geo/logging";
import { flushCaptureLogs, startCloudRunner } from "./cloud-runner";
import { checkObjectStore } from "./object-store";
import { ensureProviderConfigs } from "./providers";

const database = await openDatabase();
await migrateDatabase(database);
await ensureProviderConfigs(database);
await checkObjectStore();
const stop = startCloudRunner(database);
const logger = new StructuredLogger("capture-worker");
logger.info("service.started", "GEO Capture Worker 已启动");

await new Promise<void>((resolve) => {
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			stop();
			void Promise.all([logger.flush(), flushCaptureLogs()])
				.then(() => database.close())
				.finally(resolve);
		});
});
