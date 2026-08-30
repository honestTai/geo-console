import { homedir } from "node:os";
import { join } from "node:path";

const appDataRoot =
	process.env.GEO_DATA_DIR?.trim() || join(homedir(), "Library", "Application Support", "GEO Console");

export const geoPaths = {
	root: appDataRoot,
	database: join(appDataRoot, "database"),
	artifacts: join(appDataRoot, "artifacts"),
	logs: join(appDataRoot, "logs"),
	backups: join(appDataRoot, "backups"),
};
