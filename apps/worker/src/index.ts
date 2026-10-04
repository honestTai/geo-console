import { startApiService } from "./api-service";

const service = await startApiService({ storageOnly: process.env.GEO_SERVER_MODE === "storage" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => void service.close().finally(() => process.exit(0)));
