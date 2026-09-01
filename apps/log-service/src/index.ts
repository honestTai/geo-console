import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { migrateDatabase, openDatabase } from "@geo/core";
import { createLogServiceHandler, ingestServiceLogs, logServiceErrorStatus, pruneAllExpiredLogs } from "./service";

const host = process.env.GEO_LOG_SERVICE_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.GEO_LOG_SERVICE_PORT || 3020);
const retentionDays = Math.max(7, Math.min(3_650, Number(process.env.GEO_LOG_RETENTION_DAYS || 90)));
const token =
	process.env.GEO_LOG_SERVICE_TOKEN?.trim() ||
	(process.env.GEO_LOG_SERVICE_TOKEN_FILE?.trim()
		? (await readFile(process.env.GEO_LOG_SERVICE_TOKEN_FILE.trim(), "utf8")).trim()
		: null);
if (process.env.NODE_ENV === "production" && !token)
	throw new Error("生产环境必须通过 GEO_LOG_SERVICE_TOKEN 或 GEO_LOG_SERVICE_TOKEN_FILE 配置日志服务令牌");

const database = await openDatabase();
await migrateDatabase(database);
const startupPruned = await pruneAllExpiredLogs(database, retentionDays);
await ingestServiceLogs(database, {
	logs: [
		{
			service: "log-service",
			level: "info",
			event: "service.started",
			message: "独立日志服务已启动",
			metadata: { retentionDays, startupPruned },
		},
	],
});
const handler = createLogServiceHandler(database, token, retentionDays);
const server = createServer((request, response) => {
	handler(request, response).catch((error) => {
		console.error(
			JSON.stringify({
				service: "log-service",
				level: "error",
				event: "request.failed",
				message: error instanceof Error ? error.message : "日志请求失败",
			}),
		);
		if (!response.headersSent) {
			response.writeHead(logServiceErrorStatus(error), { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ error: error instanceof Error ? error.message : "日志服务请求失败" }));
		} else response.end();
	});
});
server.listen(port, host, () =>
	console.log(
		JSON.stringify({
			service: "log-service",
			level: "info",
			event: "service.started",
			message: `日志服务已启动：${host}:${port}`,
		}),
	),
);

const retentionTimer = setInterval(
	() => {
		pruneAllExpiredLogs(database, retentionDays).catch((error) =>
			console.error(
				JSON.stringify({
					service: "log-service",
					level: "error",
					event: "retention.failed",
					message: error instanceof Error ? error.message : "日志清理失败",
				}),
			),
		);
	},
	24 * 60 * 60 * 1_000,
);
retentionTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		clearInterval(retentionTimer);
		server.close(() => void database.close().finally(() => process.exit(0)));
	});
