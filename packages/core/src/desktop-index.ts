// Desktop bundle boundary: never load pg, PGlite, or the legacy migration runner.
export * from "./access";
export * from "./comparability";
export type { Database, QueryResult } from "./database";
export * from "./paths";
export * from "./repository";
export * from "./schema";
export * from "./secrets";
export * from "./sqlite";
export async function openDatabase(): Promise<never> {
	throw new Error("Desktop requires an explicitly scoped SQLite workspace");
}
export async function migrateDatabase(): Promise<never> {
	throw new Error("Desktop does not run database migrations");
}
