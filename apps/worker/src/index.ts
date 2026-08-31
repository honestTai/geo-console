import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { geoPaths, migrateDatabase, openDatabase, searchProviderIds } from "@geo/core";
import { z } from "zod";
import { approveAgentRun, enqueueAgentDraft, enqueueTaskContentAgent, listAgentRuns, rejectAgentRun } from "./agent";
import { getAttribution, importAttributionCsv } from "./attribution";
import {
	AuthenticationError,
	auditRequest,
	authenticateRequest,
	createUser,
	disableUser,
	ensureBootstrapAdmin,
	hasRole,
	listAuditLogs,
	listUsers,
	login,
	logout,
} from "./auth";
import { getHRouterConfig, listHRouterModels, saveHRouterConfig } from "./hrouter";
import { checkObjectStore, readArtifact } from "./object-store";
import { ensureProviderConfigs, getProviderSettings, saveProviderConfig, testProviderConfig } from "./providers";
import {
	createReportShare,
	createReportSnapshot,
	getReportPdfStatus,
	getReportSnapshot,
	getSharedReport,
	listReportShares,
	listReportSnapshots,
	renderReportHtml,
	reportCsv,
	requestReportPdf,
	revokeReportShare,
} from "./report-snapshots";
import {
	acknowledgeDriftAlert,
	analyzeProject,
	auditProject,
	confirmProject,
	createBatch,
	createProject,
	createTasksFromFindings,
	deleteTask,
	diagnoseBatch,
	getBatch,
	getBatchReport,
	getProject,
	getProjectCostSummary,
	getProjectTrends,
	listDriftAlerts,
	listProjects,
	processDueSchedules,
	saveMonitoringSchedule,
	updateTask,
	verifyTask,
} from "./service";
import { json, readJson } from "./utils";

const host = process.env.GEO_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.GEO_WORKER_PORT || 3010);
const database = await openDatabase();
await migrateDatabase(database);
await ensureProviderConfigs(database);
await ensureBootstrapAdmin(database);
await Promise.all(Object.values(geoPaths).map((directory) => mkdir(directory, { recursive: true })));
const objectStore = await checkObjectStore();

function routeMatch(pathname: string, expression: RegExp): string[] | null {
	const match = pathname.match(expression);
	return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function serveArtifact(response: ServerResponse, artifactPath: string): Promise<void> {
	try {
		const artifact = await readArtifact(artifactPath);
		response.writeHead(200, {
			"content-type": artifact.contentType,
			"content-length": artifact.contentLength,
			"cache-control": "private, no-store",
		});
		response.end(artifact.body);
	} catch {
		json(response, 404, { error: "证据文件不存在" });
	}
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
	const agentRuns = routeMatch(path, /^\/api\/projects\/([^/]+)\/agent-runs$/);
	if (agentRuns && request.method === "GET") {
		json(response, 200, { runs: await listAgentRuns(database, agentRuns[0]) });
		return true;
	}
	const reports = routeMatch(path, /^\/api\/projects\/([^/]+)\/reports$/);
	if (reports && request.method === "GET") {
		json(response, 200, { reports: await listReportSnapshots(database, reports[0]) });
		return true;
	}
	const alerts = routeMatch(path, /^\/api\/projects\/([^/]+)\/drift-alerts$/);
	if (alerts && request.method === "GET") {
		json(response, 200, { alerts: await listDriftAlerts(database, alerts[0]) });
		return true;
	}
	const costs = routeMatch(path, /^\/api\/projects\/([^/]+)\/costs$/);
	if (costs && request.method === "GET") {
		json(response, 200, await getProjectCostSummary(database, costs[0]));
		return true;
	}
	return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is a flat, auditable HTTP route dispatcher; domain behavior remains in services.
async function handleBatchTaskRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	actorUserId: string | null,
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
		const batchValue = await getBatch(database, modelDiagnosis[0]);
		if (!batchValue) throw new Error("采集批次不存在");
		json(
			response,
			202,
			await enqueueAgentDraft(database, {
				projectId: String(batchValue.project_id),
				batchId: modelDiagnosis[0],
				purpose: "diagnosis",
			}),
		);
		return true;
	}
	const batchAgent = routeMatch(path, /^\/api\/batches\/([^/]+)\/agent$/);
	if (batchAgent && request.method === "POST") {
		const body = z
			.object({ purpose: z.enum(["diagnosis", "remediation", "content_brief", "report_narrative", "quality_review"]) })
			.parse(await readJson(request));
		const batchValue = await getBatch(database, batchAgent[0]);
		if (!batchValue) throw new Error("采集批次不存在");
		json(
			response,
			202,
			await enqueueAgentDraft(database, {
				projectId: String(batchValue.project_id),
				batchId: batchAgent[0],
				purpose: body.purpose,
			}),
		);
		return true;
	}
	const approveAgent = routeMatch(path, /^\/api\/agent-runs\/([^/]+)\/approve$/);
	if (approveAgent && request.method === "POST") {
		await approveAgentRun(database, approveAgent[0], actorUserId);
		json(response, 200, { approved: true });
		return true;
	}
	const acknowledgeAlert = routeMatch(path, /^\/api\/drift-alerts\/([^/]+)\/acknowledge$/);
	if (acknowledgeAlert && request.method === "POST") {
		await acknowledgeDriftAlert(database, acknowledgeAlert[0]);
		json(response, 200, { acknowledged: true });
		return true;
	}
	const rejectAgent = routeMatch(path, /^\/api\/agent-runs\/([^/]+)\/reject$/);
	if (rejectAgent && request.method === "POST") {
		await rejectAgentRun(database, rejectAgent[0]);
		json(response, 200, { rejected: true });
		return true;
	}
	const report = routeMatch(path, /^\/api\/batches\/([^/]+)\/report$/);
	if (report && request.method === "GET") {
		const value = await getBatchReport(database, report[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "批次不存在" });
		return true;
	}
	const reportSnapshots = routeMatch(path, /^\/api\/batches\/([^/]+)\/reports$/);
	if (reportSnapshots && request.method === "POST") {
		const body = z
			.object({
				reportType: z.enum(["quick_audit", "remediation", "retest"]),
				compareToBatchId: z.string().optional().nullable(),
			})
			.parse(await readJson(request));
		json(
			response,
			201,
			await createReportSnapshot(database, { batchId: reportSnapshots[0], ...body, createdBy: actorUserId }),
		);
		return true;
	}
	const snapshot = routeMatch(path, /^\/api\/reports\/([^/]+)$/);
	if (snapshot && request.method === "GET") {
		const value = await getReportSnapshot(database, snapshot[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "报告快照不存在" });
		return true;
	}
	const snapshotPdf = routeMatch(path, /^\/api\/reports\/([^/]+)\/pdf$/);
	if (snapshotPdf && request.method === "POST") {
		json(response, 202, await requestReportPdf(database, snapshotPdf[0]));
		return true;
	}
	if (snapshotPdf && request.method === "GET") {
		json(response, 200, await getReportPdfStatus(database, snapshotPdf[0]));
		return true;
	}
	const snapshotShare = routeMatch(path, /^\/api\/reports\/([^/]+)\/shares$/);
	if (snapshotShare && request.method === "GET") {
		json(response, 200, { shares: await listReportShares(database, snapshotShare[0]) });
		return true;
	}
	if (snapshotShare && request.method === "POST") {
		const body = z
			.object({ expiresInDays: z.number().int().min(1).max(365).default(30) })
			.parse(await readJson(request));
		json(response, 201, await createReportShare(database, snapshotShare[0], body.expiresInDays, actorUserId));
		return true;
	}
	const snapshotCsv = routeMatch(path, /^\/api\/reports\/([^/]+)\/export\.csv$/);
	if (snapshotCsv && request.method === "GET") {
		const value = await getReportSnapshot(database, snapshotCsv[0]);
		if (!value) {
			json(response, 404, { error: "报告快照不存在" });
			return true;
		}
		response.writeHead(200, {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="geo-report-${snapshotCsv[0]}.csv"`,
		});
		response.end(`\uFEFF${reportCsv(value)}`);
		return true;
	}
	const share = routeMatch(path, /^\/api\/report-shares\/([^/]+)$/);
	if (share && request.method === "DELETE") {
		await revokeReportShare(database, share[0]);
		json(response, 200, { revoked: true });
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
		json(response, 202, await enqueueTaskContentAgent(database, content[0]));
		return true;
	}
	return false;
}

async function handleSettingsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<boolean> {
	if (path === "/api/settings" && request.method === "GET") {
		json(response, 200, {
			providers: await getProviderSettings(database),
			analysis: await getHRouterConfig(database),
		});
		return true;
	}
	if (path === "/api/settings/hrouter" && request.method === "PUT") {
		await saveHRouterConfig(database, await readJson(request));
		json(response, 200, { saved: true });
		return true;
	}
	if (path === "/api/settings/hrouter/models" && request.method === "GET") {
		json(response, 200, { models: await listHRouterModels(database) });
		return true;
	}
	if (path === "/api/settings/hrouter/test" && request.method === "POST") {
		const config = await getHRouterConfig(database);
		const models = await listHRouterModels(database);
		json(response, 200, { connected: true, selectedModelAvailable: models.some((model) => model.id === config.model) });
		return true;
	}
	const provider = routeMatch(path, /^\/api\/settings\/providers\/([^/]+)$/);
	if (provider && request.method === "PUT") {
		const providerId = z.enum(searchProviderIds).parse(provider[0]);
		await saveProviderConfig(database, providerId, await readJson(request));
		json(response, 200, { saved: true });
		return true;
	}
	const providerTest = routeMatch(path, /^\/api\/settings\/providers\/([^/]+)\/test$/);
	if (providerTest && request.method === "POST") {
		const providerId = z.enum(searchProviderIds).parse(providerTest[0]);
		json(response, 200, await testProviderConfig(database, providerId));
		return true;
	}
	return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Authentication and public-route ordering are intentionally centralized in one request boundary.
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const allowedOrigin = process.env.GEO_ALLOWED_ORIGIN?.trim() || "http://127.0.0.1:3000";
	if (request.headers.origin === allowedOrigin) {
		response.setHeader("access-control-allow-origin", allowedOrigin);
		response.setHeader("access-control-allow-credentials", "true");
	}
	response.setHeader("access-control-allow-headers", "authorization,content-type");
	response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (request.method === "OPTIONS") {
		response.writeHead(204);
		response.end();
		return;
	}
	const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
	const shared = routeMatch(path, /^\/share\/([^/]+)$/);
	if (shared && request.method === "GET") {
		const snapshot = await getSharedReport(database, shared[0]);
		if (!snapshot) return json(response, 404, { error: "分享链接不存在、已过期或已撤销" });
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
		response.end(renderReportHtml(snapshot));
		return;
	}
	if (path === "/api/auth/login" && request.method === "POST") {
		json(response, 200, { user: await login(database, response, await readJson(request)) });
		return;
	}
	if (path === "/api/health")
		return json(response, 200, {
			status: "ok",
			database: process.env.DATABASE_URL ? "postgresql" : "pglite",
			analysisConfigured: (await getHRouterConfig(database)).configured,
			captureRunner: "cloud",
			objectStore,
		});
	if (path.startsWith("/artifacts/")) {
		const identity = await authenticateRequest(database, request);
		if (!identity) return json(response, 401, { error: "请先登录" });
		await serveArtifact(response, path.slice("/artifacts/".length));
		return;
	}
	const identity = await authenticateRequest(database, request);
	if (!identity) return json(response, 401, { error: "请先登录" });
	if (path === "/api/auth/me" && request.method === "GET") return json(response, 200, { user: identity });
	if (path === "/api/auth/logout" && request.method === "POST") {
		await logout(database, request, response);
		return json(response, 200, { loggedOut: true });
	}
	const adminOnly =
		path.startsWith("/api/settings") || path.startsWith("/api/users") || path.startsWith("/api/audit-logs");
	const requiredRole = adminOnly ? "admin" : request.method === "GET" ? "viewer" : "analyst";
	if (!hasRole(identity, requiredRole)) return json(response, 403, { error: "当前角色无权执行此操作" });
	if (path === "/api/users" && request.method === "GET")
		return json(response, 200, { users: await listUsers(database) });
	if (path === "/api/audit-logs" && request.method === "GET")
		return json(response, 200, { logs: await listAuditLogs(database) });
	if (path === "/api/users" && request.method === "POST") {
		const value = await createUser(database, await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 201, value);
	}
	const user = routeMatch(path, /^\/api\/users\/([^/]+)$/);
	if (user && request.method === "DELETE") {
		await disableUser(database, user[0], identity.id);
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { disabled: true });
	}
	const handled =
		(await handleProjectRoutes(request, response, path)) ||
		(await handleProjectDataRoutes(request, response, path)) ||
		(await handleBatchTaskRoutes(request, response, path, identity.id)) ||
		(await handleSettingsRoutes(request, response, path));
	if (handled) {
		await auditRequest(database, identity, request.method ?? "GET", path);
		return;
	}
	json(response, 404, { error: "接口不存在" });
}

const server = createServer((request, response) => {
	handle(request, response).catch((error) => {
		console.error(error);
		if (!response.headersSent)
			json(response, error instanceof z.ZodError ? 400 : error instanceof AuthenticationError ? 401 : 500, {
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
