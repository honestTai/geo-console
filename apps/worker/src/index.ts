import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import {
	claimCaptureJob,
	failJob,
	geoPaths,
	migrateDatabase,
	openDatabase,
	readSecret,
	renewJobLease,
	writeSecret,
} from "@geo/core";
import { z } from "zod";
import { getAttribution, importAttributionCsv } from "./attribution";
import { deepSeekStructured, getDeepSeekModel } from "./deepseek";
import {
	analyzeProject,
	auditProject,
	authenticateCollector,
	confirmProject,
	createBatch,
	createCollectorNode,
	createProject,
	createTasksFromFindings,
	deleteTask,
	diagnoseBatch,
	generateTaskContent,
	getBatch,
	getBatchReport,
	getProject,
	getProjectTrends,
	listCollectorNodes,
	listProjects,
	processDueSchedules,
	revokeCollectorNode,
	saveMonitoringSchedule,
	storeCapture,
	updateTask,
	verifyTask,
} from "./service";
import { json, readJson } from "./utils";

const host = process.env.GEO_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.GEO_WORKER_PORT || 3010);
const database = await openDatabase();
await migrateDatabase(database);
await Promise.all(Object.values(geoPaths).map((directory) => mkdir(directory, { recursive: true })));

function routeMatch(pathname: string, expression: RegExp): string[] | null {
	const match = pathname.match(expression);
	return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function requireAdmin(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
	const password = await readSecret("admin_password");
	if (!password) return true;
	const encoded = request.headers.authorization?.match(/^Basic (.+)$/)?.[1];
	const supplied = encoded ? Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":") : "";
	if (supplied === password) return true;
	response.writeHead(401, { "www-authenticate": 'Basic realm="GEO Console"' });
	response.end("需要管理员认证");
	return false;
}

async function collectorIdentity(request: IncomingMessage): Promise<{ id: string } | null> {
	const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
	return token ? authenticateCollector(database, token) : null;
}

async function serveArtifact(response: ServerResponse, artifactPath: string): Promise<void> {
	const relative = normalize(artifactPath).replace(/^([/\\])+/, "");
	const absolute = join(geoPaths.artifacts, relative);
	if (!absolute.startsWith(`${geoPaths.artifacts}${sep}`)) return json(response, 400, { error: "非法文件路径" });
	try {
		await stat(absolute);
		const contentType =
			extname(absolute) === ".png"
				? "image/png"
				: extname(absolute) === ".html"
					? "text/html; charset=utf-8"
					: "application/octet-stream";
		response.writeHead(200, { "content-type": contentType, "cache-control": "private, no-store" });
		createReadStream(absolute).pipe(response);
	} catch {
		json(response, 404, { error: "证据文件不存在" });
	}
}

async function handleCollector(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
	const node = await collectorIdentity(request);
	if (!node) return json(response, 401, { error: "Collector 节点令牌无效或已撤销" });
	if (path === "/api/collector/heartbeat" && request.method === "POST") {
		const body = z
			.object({ version: z.string().trim().min(1).optional(), capabilities: z.array(z.string()).optional() })
			.parse(await readJson(request));
		await database.query(
			`UPDATE collector_nodes SET last_seen_at=now(),version=COALESCE($2,version),
			 capabilities=CASE WHEN $3::boolean THEN $4::jsonb ELSE capabilities END WHERE id=$1`,
			[node.id, body.version ?? null, Boolean(body.capabilities), JSON.stringify(body.capabilities ?? [])],
		);
		return json(response, 200, { nodeId: node.id });
	}
	if (path === "/api/collector/jobs/next" && request.method === "POST") {
		await database.query("UPDATE collector_nodes SET last_seen_at=now() WHERE id=$1", [node.id]);
		return json(response, 200, { nodeId: node.id, job: await claimCaptureJob(database, node.id) });
	}
	const renew = routeMatch(path, /^\/api\/collector\/jobs\/([^/]+)\/renew$/);
	if (renew && request.method === "POST")
		return json(response, 200, { renewed: await renewJobLease(database, renew[0], node.id) });
	const result = routeMatch(path, /^\/api\/collector\/jobs\/([^/]+)\/result$/);
	if (result && request.method === "POST") {
		const body = z
			.object({ capture: z.unknown(), screenshotBase64: z.string().optional() })
			.parse(await readJson(request));
		const capture = {
			...(body.capture as Record<string, unknown>),
			jobId: result[0],
			evidence: { ...((body.capture as Record<string, unknown>).evidence as object), captureNodeId: node.id },
		};
		await storeCapture(database, capture, body.screenshotBase64);
		return json(response, 201, { stored: true });
	}
	const failure = routeMatch(path, /^\/api\/collector\/jobs\/([^/]+)\/failure$/);
	if (failure && request.method === "POST") {
		const body = z.object({ message: z.string().min(1) }).parse(await readJson(request));
		await failJob(database, failure[0], node.id, body.message);
		return json(response, 200, { accepted: true });
	}
	return json(response, 404, { error: "Collector 接口不存在" });
}

async function handleProjectRoutes(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
	if (path === "/api/projects" && request.method === "GET")
		return json(response, 200, { projects: await listProjects(database) }) ?? true;
	if (path === "/api/projects" && request.method === "POST")
		return json(response, 201, await createProject(database, await readJson(request))) ?? true;
	const project = routeMatch(path, /^\/api\/projects\/([^/]+)$/);
	if (project && request.method === "GET") {
		const value = await getProject(database, project[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "客户项目不存在" });
		return true;
	}
	const analyze = routeMatch(path, /^\/api\/projects\/([^/]+)\/analyze$/);
	if (analyze && request.method === "POST") {
		json(response, 200, await analyzeProject(database, analyze[0]));
		return true;
	}
	const confirm = routeMatch(path, /^\/api\/projects\/([^/]+)\/confirm$/);
	if (confirm && request.method === "POST") {
		await confirmProject(database, confirm[0], await readJson(request));
		json(response, 200, { confirmed: true });
		return true;
	}
	const audit = routeMatch(path, /^\/api\/projects\/([^/]+)\/audit$/);
	if (audit && request.method === "POST") {
		json(response, 201, await auditProject(database, audit[0]));
		return true;
	}
	const batches = routeMatch(path, /^\/api\/projects\/([^/]+)\/batches$/);
	if (batches && request.method === "POST") {
		json(response, 201, await createBatch(database, batches[0], await readJson(request)));
		return true;
	}
	const tasks = routeMatch(path, /^\/api\/projects\/([^/]+)\/tasks\/from-findings$/);
	if (tasks && request.method === "POST") {
		const body = z.object({ batchId: z.string() }).parse(await readJson(request));
		json(response, 201, await createTasksFromFindings(database, tasks[0], body.batchId));
		return true;
	}
	return false;
}

async function handleProjectDataRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<boolean> {
	const schedule = routeMatch(path, /^\/api\/projects\/([^/]+)\/monitoring-schedule$/);
	if (schedule && request.method === "PUT") {
		await saveMonitoringSchedule(database, schedule[0], await readJson(request));
		json(response, 200, { saved: true });
		return true;
	}
	const latestTrends = routeMatch(path, /^\/api\/projects\/([^/]+)\/trends$/);
	if (latestTrends && request.method === "GET") {
		json(response, 200, await getProjectTrends(database, latestTrends[0]));
		return true;
	}
	const batchTrends = routeMatch(path, /^\/api\/projects\/([^/]+)\/trends\/([^/]+)$/);
	if (batchTrends && request.method === "GET") {
		json(response, 200, await getProjectTrends(database, batchTrends[0], batchTrends[1]));
		return true;
	}
	const attribution = routeMatch(path, /^\/api\/projects\/([^/]+)\/attribution$/);
	if (attribution && request.method === "GET") {
		json(response, 200, await getAttribution(database, attribution[0]));
		return true;
	}
	const attributionImport = routeMatch(path, /^\/api\/projects\/([^/]+)\/attribution\/import$/);
	if (attributionImport && request.method === "POST") {
		json(response, 201, await importAttributionCsv(database, attributionImport[0], await readJson(request)));
		return true;
	}
	return false;
}

async function handleBatchTaskRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<boolean> {
	const batch = routeMatch(path, /^\/api\/batches\/([^/]+)$/);
	if (batch && request.method === "GET") {
		const value = await getBatch(database, batch[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "批次不存在" });
		return true;
	}
	const diagnosis = routeMatch(path, /^\/api\/batches\/([^/]+)\/diagnose$/);
	if (diagnosis && request.method === "POST") {
		json(response, 201, await diagnoseBatch(database, diagnosis[0]));
		return true;
	}
	const modelDiagnosis = routeMatch(path, /^\/api\/batches\/([^/]+)\/diagnose\/model$/);
	if (modelDiagnosis && request.method === "POST") {
		json(response, 201, await diagnoseBatch(database, modelDiagnosis[0], { enhanceWithModel: true }));
		return true;
	}
	const report = routeMatch(path, /^\/api\/batches\/([^/]+)\/report$/);
	if (report && request.method === "GET") {
		const value = await getBatchReport(database, report[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "批次不存在" });
		return true;
	}
	const task = routeMatch(path, /^\/api\/tasks\/([^/]+)$/);
	if (task && request.method === "PATCH") {
		await updateTask(database, task[0], await readJson(request));
		json(response, 200, { updated: true });
		return true;
	}
	if (task && request.method === "DELETE") {
		await deleteTask(database, task[0]);
		json(response, 200, { deleted: true });
		return true;
	}
	const verify = routeMatch(path, /^\/api\/tasks\/([^/]+)\/verify$/);
	if (verify && request.method === "POST") {
		json(response, 200, await verifyTask(database, verify[0]));
		return true;
	}
	const content = routeMatch(path, /^\/api\/tasks\/([^/]+)\/content$/);
	if (content && request.method === "POST") {
		await generateTaskContent(database, content[0]);
		json(response, 200, { generated: true });
		return true;
	}
	return false;
}

async function handleSettingsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<boolean> {
	if (path === "/api/collector-nodes" && request.method === "POST") {
		const body = z.object({ name: z.string().trim().min(1) }).parse(await readJson(request));
		json(response, 201, await createCollectorNode(database, body.name));
		return true;
	}
	if (path === "/api/collector-nodes" && request.method === "GET") {
		json(response, 200, { nodes: await listCollectorNodes(database) });
		return true;
	}
	const collectorNode = routeMatch(path, /^\/api\/collector-nodes\/([^/]+)$/);
	if (collectorNode && request.method === "DELETE") {
		await revokeCollectorNode(database, collectorNode[0]);
		json(response, 200, { revoked: true });
		return true;
	}
	if (path === "/api/settings" && request.method === "GET") {
		json(response, 200, {
			deepseek: { configured: Boolean(await readSecret("deepseek_api_key")), model: getDeepSeekModel() },
		});
		return true;
	}
	if (path === "/api/settings/deepseek" && request.method === "PUT") {
		const body = z.object({ apiKey: z.string().trim().min(10) }).parse(await readJson(request));
		await writeSecret("deepseek_api_key", body.apiKey);
		json(response, 200, { saved: true });
		return true;
	}
	if (path === "/api/settings/deepseek/test" && request.method === "POST") {
		const validate = z.object({ ok: z.literal(true) });
		await deepSeekStructured({
			name: "connection_test",
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["ok"],
				properties: { ok: { type: "boolean", const: true } },
			},
			instructions: "仅按指定JSON返回连接测试结果。",
			input: "返回 ok=true",
			validate,
		});
		json(response, 200, { connected: true, model: getDeepSeekModel() });
		return true;
	}
	return false;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	response.setHeader("access-control-allow-origin", "http://127.0.0.1:3000");
	response.setHeader("access-control-allow-headers", "authorization,content-type");
	response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (request.method === "OPTIONS") {
		response.writeHead(204);
		response.end();
		return;
	}
	const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
	if (path === "/api/health")
		return json(response, 200, {
			status: "ok",
			database: process.env.DATABASE_URL ? "postgresql" : "pglite",
			model: getDeepSeekModel(),
		});
	if (path.startsWith("/artifacts/")) {
		if (await requireAdmin(request, response)) await serveArtifact(response, path.slice("/artifacts/".length));
		return;
	}
	if (path.startsWith("/api/collector/")) return handleCollector(request, response, path);
	if (!(await requireAdmin(request, response))) return;
	if (await handleProjectRoutes(request, response, path)) return;
	if (await handleProjectDataRoutes(request, response, path)) return;
	if (await handleBatchTaskRoutes(request, response, path)) return;
	if (await handleSettingsRoutes(request, response, path)) return;
	json(response, 404, { error: "接口不存在" });
}

const server = createServer((request, response) => {
	handle(request, response).catch((error) => {
		console.error(error);
		if (!response.headersSent)
			json(response, error instanceof z.ZodError ? 400 : 500, {
				error: error instanceof Error ? error.message : "未知错误",
			});
		else response.end();
	});
});

server.listen(port, host, () => console.log(`GEO Worker: http://${host}:${port}`));

const scheduleTimer = setInterval(() => {
	processDueSchedules(database).catch((error) => console.error("自动监测调度失败", error));
}, 60_000);
scheduleTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		clearInterval(scheduleTimer);
		server.close(() => database.close().finally(() => process.exit(0)));
	});
