import { migrateDatabase, openDatabase } from "@geo/core";
import { startSemanticRuntime } from "./semantic-runtime";

const database = await openDatabase();
await migrateDatabase(database);
const stop = startSemanticRuntime(database);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void stop().finally(() => database.close().finally(() => process.exit(0)));
	});
