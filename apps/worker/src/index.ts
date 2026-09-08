import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { geoPaths, migrateDatabase, openDatabase, searchProviderIds } from "@geo/core";
import { checkLogService, LogServiceUnavailableError, StructuredLogger, safeErrorMessage } from "@geo/logging";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { z } from "zod";
import { approveAgentRun, enqueueAgentDraft, enqueueTaskContentAgent, listAgentRuns, rejectAgentRun } from "./agent";
import { enqueueAnswerAnalysis, getAnswerAnalysis } from "./answer-analysis";
import { apiErrorResponse } from "./api-errors";
import { continueApprovedReport } from "./approval-workflow";
import {
	deleteArticle,
	generateArticlesForBatch,
	getArticle,
	listArticles,
	regenerateArticle,
	updateArticle,
} from "./articles";
import { getAttribution, importAttributionCsv } from "./attribution";
import {
	AuthenticationError,
	auditRequest,
	authenticateRequest,
	changeOwnPassword,
	createUser,
	disableUser,
	ensureBootstrapAdmin,
	type Identity,
	listAuditLogs,
	listUsers,
	login,
	logout,
	resetMemberPassword,
	restoreUser,
	selectOrganization,
} from "./auth";
import { actorFromIdentity, authorizeArtifact, authorizeRequest, principalForIdentity } from "./authorization";
import {
	explainRequest,
	listPolicies,
	requireSystemAdministrator,
	savePermission,
	savePolicy,
} from "./authorization/configuration";
import { exportKnowledge, exportSettings, importKnowledge, importSettings } from "./config-transfer";
import {
	claimDesktopTurn,
	completeDesktopTurn,
	DesktopAgentConflictError,
	executeDesktopTool,
	heartbeatDesktopTurn,
	recordDesktopEvent,
	recordDesktopMessage,
	relayDesktopAgentResponse,
} from "./desktop-agent";
import { getHRouterConfig, listHRouterModels, saveHRouterConfig } from "./hrouter";
import { routeMatch } from "./http-routes";
import { archiveLibraryQuestion, createLibraryQuestion, listLibraryQuestions } from "./knowledge-base";
import { startLocalWorkers } from "./local-workers";
import { loginClientAddress } from "./login-limiter";
import { currentMeasurement, reparseMeasurement, reviewSemanticObservation } from "./measurement";
import { listMemberOptions } from "./member-access";
import { artifactSafetyHeaders, checkObjectStore, readArtifact } from "./object-store";
import { parsePagination } from "./pagination";
import { changeProjectLifecycle } from "./project-lifecycle";
import { updateProjectProfile } from "./project-profile";
import {
	ensureProviderConfigs,
	getProviderSettings,
	listProviderModels,
	saveProviderConfig,
	testProviderConfig,
} from "./providers";
import {
	AccessDeniedError,
	createRole,
	deleteRole,
	getDynamicNavigation,
	getRbacCatalog,
	listRoles,
	updateOrganizationPermissions,
	updateRole,
	updateUserAccess,
} from "./rbac";
import {
	advanceReportWorkflow,
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
	ensureProjectSnapshots,
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
import { applyServiceLogRetention, getServiceLogs, getServiceLogsCsv } from "./service-log-proxy";
import { canAccessProject, createOrganization, listOrganizations, setOrganizationStatus } from "./tenancy";
import { HttpInputError, json, readJson } from "./utils";
import { getWebSearchTestStatus, listWebSearchEvidencePage, testWebSearch } from "./web-search";
import { getEvidenceReference, getWebsiteEvidence } from "./website-evidence";
import {
	answerQuestion,
	cancelSession,
	createSession,
	getSession,
	listSessionEvents,
	listSessions,
	orderQuickCommands,
	sendMessage,
	updateSessionSettings,
	waitForSessionUpdates,
} from "./workbench";

const host = process.env.GEO_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.GEO_WORKER_PORT || 3010);
const database = await openDatabase();
await migrateDatabase(database);
await ensureProviderConfigs(database);
await ensureBootstrapAdmin(database);
await Promise.all(Object.values(geoPaths).map((directory) => mkdir(directory, { recursive: true })));
const objectStore = await checkObjectStore();
const apiLogger = new StructuredLogger("api");
const stopLocalWorkers = process.env.GEO_LOCAL_COMBINED === "true" ? await startLocalWorkers(database) : null;

/** 路由策略之外的附加功能开关（如“同步写入知识库”）仍按有效权限判断，超管始终放行。 */
const hasPermission = (identity: Identity, permission: string): boolean =>
	identity.isSuperAdmin || identity.permissions.includes(permission);
const isDesktopRequest = (request: IncomingMessage): boolean =>
	request.headers["x-geo-client"] === "desktop" &&
	/(?:^|\s)ZZGeoDesktop\/\d+\.\d+\.\d+(?:[+.-][0-9A-Za-z.-]+)?(?:\s|$)/.test(request.headers["user-agent"] ?? "");
const isDesktopRuntimePlumbing = (path: string): boolean =>
	/^\/api\/workbench\/sessions\/[^/]+\/desktop\/(claim|heartbeat|events|messages|complete|responses)$/.test(path);
const isQuietDesktopRuntimePath = (path: string): boolean =>
	/^\/api\/workbench\/sessions\/[^/]+\/desktop\/(heartbeat|events|messages)$/.test(path);

function assertDesktopRequest(request: IncomingMessage): void {
	if (!isDesktopRequest(request)) throw new AccessDeniedError("该接口只允许 ZZ Geo 桌面客户端访问");
}

async function serveArtifact(response: ServerResponse, artifactPath: string): Promise<void> {
	try {
		const artifact = await readArtifact(artifactPath);
		response.writeHead(200, {
			"content-type": artifact.contentType,
			...artifactSafetyHeaders(artifact.contentType),
			"content-length": artifact.contentLength,
			"cache-control": "private, no-store",
		});
		response.end(artifact.body);
	} catch {
		json(response, 404, { error: "证据文件不存在" });
	}
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This auditable dispatcher keeps project ownership and pagination at one HTTP boundary.
async function handleProjectRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	identity: Identity,
): Promise<boolean> {
	if (path === "/api/projects" && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listProjects(
				database,
				identity.organizationId,
				parsePagination(url),
				{
					allProjects: identity.allProjects,
					projectIds: identity.projectIds,
				},
				z.enum(["all", "open", "archived"]).parse(url.searchParams.get("status") ?? "all"),
			),
		);
		return true;
	}
	if (path === "/api/projects" && request.method === "POST")
		return (
			json(
				response,
				201,
				await createProject(database, await readJson(request), identity.organizationId, identity.id),
			) ?? true
		);
	const project = routeMatch(path, /^\/api\/projects\/([^/]+)$/);
	const archiveProject = routeMatch(path, /^\/api\/projects\/([^/]+)\/archive$/);
	if ((archiveProject && request.method === "POST") || (project && request.method === "DELETE")) {
		const projectId = (archiveProject ?? project)![0];
		json(
			response,
			200,
			await changeProjectLifecycle(
				database,
				projectId,
				archiveProject ? "archive" : "delete",
				await readJson(request),
				actorFromIdentity(identity),
			),
		);
		return true;
	}
	const websiteEvidence = routeMatch(path, /^\/api\/projects\/([^/]+)\/website-evidence\/([^/]+)$/);
	const evidenceReference = routeMatch(path, /^\/api\/projects\/([^/]+)\/evidence-reference\/([^/]+)$/);
	if (evidenceReference && request.method === "GET") {
		json(response, 200, await getEvidenceReference(database, evidenceReference[0], evidenceReference[1]));
		return true;
	}
	if (websiteEvidence && request.method === "GET") {
		json(response, 200, await getWebsiteEvidence(database, websiteEvidence[0], websiteEvidence[1]));
		return true;
	}
	if (project && request.method === "PUT") {
		json(response, 200, await updateProjectProfile(database, project[0], await readJson(request)));
		return true;
	}
	if (project && request.method === "GET") {
		const value = await getProject(database, project[0]);
		if (value) {
			if (!identity.permissions.includes("page.remediation")) value.tasks = [];
			if (!identity.permissions.includes("page.diagnosis")) value.findings = [];
			if (!identity.permissions.includes("page.audit")) value.websiteAudits = [];
			json(response, 200, value);
		} else json(response, 404, { error: "客户项目不存在" });
		return true;
	}
	const analyze = routeMatch(path, /^\/api\/projects\/([^/]+)\/analyze$/);
	if (analyze && request.method === "POST") {
		json(response, 200, await analyzeProject(database, analyze[0]));
		return true;
	}
	const confirm = routeMatch(path, /^\/api\/projects\/([^/]+)\/confirm$/);
	if (confirm && request.method === "POST") {
		const body = (await readJson(request)) as Record<string, unknown>;
		const syncLibrary = body.syncLibrary === true;
		if (syncLibrary && !hasPermission(identity, "knowledge.manage"))
			throw new AccessDeniedError("把问题写入知识库需要「维护问题知识库」权限");
		const result = await confirmProject(database, confirm[0], body, {
			syncLibrary: syncLibrary ? { organizationId: identity.organizationId, createdBy: identity.id } : null,
		});
		json(response, 200, { confirmed: true, ...result });
		return true;
	}
	const research = routeMatch(path, /^\/api\/projects\/([^/]+)\/agent$/);
	if (research && request.method === "POST") {
		// 建档页“后台联网出题”：非交互的 prompt_research 草稿，批准后作为候选进入建档页；先保证有官网快照可引用。
		const body = z.object({ purpose: z.literal("prompt_research") }).parse(await readJson(request));
		await ensureProjectSnapshots(database, research[0]);
		json(
			response,
			202,
			await enqueueAgentDraft(database, {
				projectId: research[0],
				purpose: body.purpose,
				actor: actorFromIdentity(identity),
			}),
		);
		return true;
	}
	const webSearches = routeMatch(path, /^\/api\/projects\/([^/]+)\/web-searches$/);
	if (webSearches && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listWebSearchEvidencePage(database, webSearches[0], parsePagination(url), {
				id: url.searchParams.get("id"),
				status: url.searchParams.get("status"),
			}),
		);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Project data endpoints intentionally remain explicit for dynamic route-policy matching.
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
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(response, 200, await getAttribution(database, attribution[0], parsePagination(url)));
		return true;
	}
	const attributionImport = routeMatch(path, /^\/api\/projects\/([^/]+)\/attribution\/import$/);
	if (attributionImport && request.method === "POST") {
		json(response, 201, await importAttributionCsv(database, attributionImport[0], await readJson(request)));
		return true;
	}
	const agentRuns = routeMatch(path, /^\/api\/projects\/([^/]+)\/agent-runs$/);
	if (agentRuns && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listAgentRuns(database, agentRuns[0], parsePagination(url), {
				batchId: url.searchParams.get("batchId"),
				purposes: url.searchParams.get("purposes")?.split(","),
			}),
		);
		return true;
	}
	const reports = routeMatch(path, /^\/api\/projects\/([^/]+)\/reports$/);
	if (reports && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listReportSnapshots(database, reports[0], parsePagination(url), url.searchParams.get("batchId")),
		);
		return true;
	}
	const alerts = routeMatch(path, /^\/api\/projects\/([^/]+)\/drift-alerts$/);
	if (alerts && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(response, 200, await listDriftAlerts(database, alerts[0], parsePagination(url)));
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
	identity: Identity,
): Promise<boolean> {
	const actorUserId = identity.id;
	const actor = actorFromIdentity(identity);
	const answerAnalysisRoute = routeMatch(path, /^\/api\/batches\/([^/]+)\/captures\/([^/]+)\/analysis$/);
	if (answerAnalysisRoute) {
		const [batchId, captureId] = answerAnalysisRoute;
		if (request.method === "POST") {
			json(response, 202, await enqueueAnswerAnalysis(database, batchId, captureId, actor));
			return true;
		}
		if (request.method === "GET") {
			const url = new URL(request.url ?? path, "http://local");
			json(response, 200, await getAnswerAnalysis(database, batchId, captureId, url.searchParams.get("runId")));
			return true;
		}
	}
	const measurementRoute = routeMatch(path, /^\/api\/batches\/([^/]+)\/measurement(\/review)?$/);
	if (measurementRoute) {
		const [batchId, review] = measurementRoute;
		if (request.method === "POST") {
			if (review) {
				await reviewSemanticObservation(database, batchId, await readJson(request), actorUserId);
				json(response, 200, { reviewed: true });
			} else json(response, 202, await reparseMeasurement(database, batchId, actorUserId));
			return true;
		}
		if (request.method === "GET" && !review) {
			const current = await currentMeasurement(database, batchId);
			const url = new URL(request.url ?? path, "http://local");
			const page = parsePagination(url);
			const observations = await database.query(
				`SELECT o.*,s.observation_id IS NOT NULL AS selected FROM semantic_observations o
				LEFT JOIN semantic_selections s ON s.observation_id=o.id WHERE o.run_id=$1 ORDER BY o.created_at DESC,o.id LIMIT $2 OFFSET $3`,
				[current.runId, page.pageSize, page.offset],
			);
			const total = Number(
				(
					await database.query<{ count: number }>(
						"SELECT count(*)::int AS count FROM semantic_observations WHERE run_id=$1",
						[current.runId],
					)
				).rows[0].count,
			);
			json(response, 200, {
				...current,
				observations: observations.rows,
				total,
				page: page.page,
				pageSize: page.pageSize,
			});
			return true;
		}
	}
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
				actor,
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
				actor,
			}),
		);
		return true;
	}
	const approveAgent = routeMatch(path, /^\/api\/agent-runs\/([^/]+)\/approve$/);
	if (approveAgent && request.method === "POST") {
		const approved = await approveAgentRun(database, approveAgent[0], actorUserId, "manual", undefined, actor);
		const next = await continueApprovedReport(approved, (batchId) =>
			advanceReportWorkflow(database, batchId, { createdBy: actorUserId, allowRetry: false, actor }),
		);
		const workflowError =
			next.status === "blocked"
				? apiErrorResponse(next.error, String(response.getHeader("x-request-id") ?? "")).body.error
				: null;
		if (next.status === "blocked")
			apiLogger.warn("report.continuation_blocked", safeErrorMessage(next.error), {
				organizationId: identity.organizationId,
				metadata: { runId: approveAgent[0], approvalCommitted: true },
			});
		json(response, 200, { approved: true, workflow: next.workflow, workflowError, continuationStatus: next.status });
		return true;
	}
	const reportWorkflow = routeMatch(path, /^\/api\/batches\/([^/]+)\/report-workflow$/);
	if (reportWorkflow && request.method === "POST") {
		const body = z.object({ restart: z.boolean().default(false) }).parse(await readJson(request));
		json(
			response,
			202,
			await advanceReportWorkflow(database, reportWorkflow[0], {
				createdBy: actorUserId,
				actor,
				allowRetry: true,
				restart: body.restart,
			}),
		);
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
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(response, 200, await listReportShares(database, snapshotShare[0], parsePagination(url)));
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
		json(response, 202, await enqueueTaskContentAgent(database, content[0], actor));
		return true;
	}
	return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Workbench and article endpoints stay explicit for dynamic route-policy matching.
async function handleWorkbenchRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	identity: Identity,
): Promise<boolean> {
	const actorUserId = identity.id;
	const sessions = routeMatch(path, /^\/api\/projects\/([^/]+)\/workbench\/sessions$/);
	if (sessions && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		const projectRow = (
			await database.query<{ status: string; approved_prompt_count: number }>(
				`SELECT status,(SELECT count(*)::int FROM prompts WHERE project_id=p.id AND approved=true AND archived_at IS NULL) AS approved_prompt_count
				 FROM projects p WHERE id=$1`,
				[sessions[0]],
			)
		).rows[0];
		json(response, 200, {
			...(await listSessions(database, sessions[0], parsePagination(url))),
			quickCommands: orderQuickCommands({
				status: projectRow?.status ?? "draft",
				approvedPromptCount: Number(projectRow?.approved_prompt_count ?? 0),
			}),
		});
		return true;
	}
	if (sessions && request.method === "POST") {
		json(
			response,
			201,
			await createSession(database, sessions[0], await readJson(request), actorUserId, {
				desktopClient: isDesktopRequest(request),
				actor: actorFromIdentity(identity),
			}),
		);
		return true;
	}
	const desktop = routeMatch(
		path,
		/^\/api\/workbench\/sessions\/([^/]+)\/desktop\/(claim|heartbeat|events|messages|tools|complete|responses)$/,
	);
	if (desktop && request.method === "POST") {
		assertDesktopRequest(request);
		const [sessionId, action] = desktop;
		const actor = { userId: actorUserId, isSuperAdmin: identity.isSuperAdmin };
		const body = (await readJson(request)) as Record<string, unknown>;
		if (action === "claim") json(response, 200, await claimDesktopTurn(database, sessionId, body, actor));
		else if (action === "heartbeat") json(response, 200, await heartbeatDesktopTurn(database, sessionId, body, actor));
		else if (action === "events") json(response, 200, await recordDesktopEvent(database, sessionId, body, actor));
		else if (action === "messages") json(response, 200, await recordDesktopMessage(database, sessionId, body, actor));
		else if (action === "tools") {
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			json(response, 200, await executeDesktopTool(database, sessionId, body, actor, controller.signal));
		} else if (action === "complete") json(response, 200, await completeDesktopTurn(database, sessionId, body, actor));
		else {
			const run = { runId: body.runId, clientId: body.clientId };
			const controller = new AbortController();
			const abort = () => controller.abort();
			request.once("aborted", abort);
			response.once("close", abort);
			await relayDesktopAgentResponse(database, sessionId, run, body.request, actor, response, controller.signal);
		}
		return true;
	}
	const session = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)$/);
	if (session && request.method === "GET") {
		json(response, 200, await getSession(database, session[0]));
		return true;
	}
	const events = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)\/events$/);
	if (events && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		const after = Number(url.searchParams.get("after") ?? 0);
		const wait = Number(url.searchParams.get("wait") ?? 0);
		if (!Number.isFinite(wait) || wait <= 0) {
			json(response, 200, {
				...(await listSessionEvents(database, events[0], Number.isFinite(after) ? after : 0)),
				session: await getSession(database, events[0]),
			});
			return true;
		}
		const controller = new AbortController();
		const abort = () => controller.abort();
		response.once("close", abort);
		const updates = await waitForSessionUpdates(
			database,
			events[0],
			Number.isFinite(after) ? after : 0,
			wait,
			controller.signal,
		);
		response.off("close", abort);
		if (updates && !response.destroyed) json(response, 200, updates);
		return true;
	}
	const messages = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)\/messages$/);
	if (messages && request.method === "POST") {
		json(
			response,
			202,
			await sendMessage(database, messages[0], await readJson(request), { desktopClient: isDesktopRequest(request) }),
		);
		return true;
	}
	const answer = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)\/answer$/);
	if (answer && request.method === "POST") {
		const body = (await readJson(request)) as Record<string, unknown>;
		if (body.syncLibrary === true && !hasPermission(identity, "knowledge.manage"))
			throw new AccessDeniedError("把问题写入知识库需要「维护问题知识库」权限");
		json(
			response,
			202,
			await answerQuestion(database, answer[0], body, {
				userId: actorUserId,
				canWriteKnowledge: hasPermission(identity, "knowledge.manage"),
				desktopClient: isDesktopRequest(request),
			}),
		);
		return true;
	}
	const cancel = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)\/cancel$/);
	if (cancel && request.method === "POST") {
		await cancelSession(database, cancel[0]);
		json(response, 200, { cancelled: true });
		return true;
	}
	const settings = routeMatch(path, /^\/api\/workbench\/sessions\/([^/]+)\/settings$/);
	if (settings && request.method === "PATCH") {
		await updateSessionSettings(database, settings[0], await readJson(request));
		json(response, 200, { saved: true });
		return true;
	}
	const articles = routeMatch(path, /^\/api\/projects\/([^/]+)\/articles$/);
	if (articles && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listArticles(database, articles[0], parsePagination(url), {
				batchId: url.searchParams.get("batchId"),
				status: url.searchParams.get("status"),
			}),
		);
		return true;
	}
	const generate = routeMatch(path, /^\/api\/projects\/([^/]+)\/articles\/generate$/);
	if (generate && request.method === "POST") {
		const body = z.object({ batchId: z.string().min(1) }).parse(await readJson(request));
		const batchValue = await getBatch(database, body.batchId);
		if (!batchValue || String(batchValue.project_id) !== generate[0]) throw new Error("采集批次不存在或不属于当前客户");
		json(response, 202, await generateArticlesForBatch(database, body.batchId, { actor: actorFromIdentity(identity) }));
		return true;
	}
	const article = routeMatch(path, /^\/api\/articles\/([^/]+)$/);
	if (article && request.method === "GET") {
		const value = await getArticle(database, article[0]);
		value ? json(response, 200, value) : json(response, 404, { error: "优化文章不存在" });
		return true;
	}
	if (article && request.method === "PATCH") {
		await updateArticle(database, article[0], await readJson(request));
		json(response, 200, { updated: true });
		return true;
	}
	if (article && request.method === "DELETE") {
		await deleteArticle(database, article[0]);
		json(response, 200, { deleted: true });
		return true;
	}
	const regenerate = routeMatch(path, /^\/api\/articles\/([^/]+)\/regenerate$/);
	if (regenerate && request.method === "POST") {
		json(response, 202, await regenerateArticle(database, regenerate[0], actorFromIdentity(identity)));
		return true;
	}
	return false;
}

async function handleSettingsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	organizationId: string,
): Promise<boolean> {
	if (path === "/api/settings" && request.method === "GET") {
		json(response, 200, {
			providers: await getProviderSettings(database, organizationId),
			analysis: await getHRouterConfig(database, organizationId),
		});
		return true;
	}
	if (path === "/api/settings/export" && request.method === "GET") {
		json(response, 200, await exportSettings(database, organizationId));
		return true;
	}
	if (path === "/api/settings/import" && request.method === "POST") {
		json(response, 200, await importSettings(database, organizationId, await readJson(request)));
		return true;
	}
	const provider = routeMatch(path, /^\/api\/settings\/providers\/([^/]+)$/);
	if (provider && request.method === "PUT") {
		const providerId = z.enum(searchProviderIds).parse(provider[0]);
		await saveProviderConfig(database, providerId, await readJson(request), organizationId);
		json(response, 200, { saved: true });
		return true;
	}
	const providerTest = routeMatch(path, /^\/api\/settings\/providers\/([^/]+)\/test$/);
	if (providerTest && request.method === "POST") {
		const providerId = z.enum(searchProviderIds).parse(providerTest[0]);
		json(response, 200, await testProviderConfig(database, providerId, organizationId));
		return true;
	}
	const providerModels = routeMatch(path, /^\/api\/settings\/providers\/([^/]+)\/models$/);
	if (providerModels && request.method === "GET") {
		const providerId = z.enum(searchProviderIds).parse(providerModels[0]);
		json(response, 200, await listProviderModels(database, providerId, organizationId));
		return true;
	}
	return false;
}

async function handleHRouterRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	organizationId: string,
): Promise<boolean> {
	if (path === "/api/settings/hrouter" && request.method === "PUT") {
		await saveHRouterConfig(database, await readJson(request), organizationId);
		json(response, 200, { saved: true });
		return true;
	}
	if (path === "/api/settings/hrouter/models" && request.method === "GET") {
		// 下拉框数据源：没配 Key 或 HRouter 不可达都不算服务端错误，返回空列表加说明，页面仍可手输模型
		try {
			json(response, 200, { models: await listHRouterModels(database, organizationId), message: null });
		} catch (error) {
			json(response, 200, { models: [], message: error instanceof Error ? error.message : "模型列表读取失败" });
		}
		return true;
	}
	if (path === "/api/settings/hrouter/test" && request.method === "POST") {
		const config = await getHRouterConfig(database, organizationId);
		const models = await listHRouterModels(database, organizationId);
		json(response, 200, { connected: true, selectedModelAvailable: models.some((model) => model.id === config.model) });
		return true;
	}
	if (path === "/api/settings/hrouter/test-web-search" && request.method === "POST") {
		// 验证 HRouter 对指定模型（缺省为机构默认模型）是否真的透传 OpenAI web_search；不落证据，结果按模型记住。
		const body = z
			.object({
				model: z
					.string()
					.trim()
					.regex(/^gpt(?:-|\.)/i, "联网搜索测试只支持 GPT 系列模型")
					.optional()
					.nullable(),
			})
			.parse(await readJson(request));
		const result = await testWebSearch(database, organizationId, body.model ?? null);
		json(response, 200, { ...result, searchTriggered: result.status === "ok" });
		return true;
	}
	if (path === "/api/settings/hrouter/web-search-status" && request.method === "GET") {
		json(response, 200, await getWebSearchTestStatus(database, organizationId));
		return true;
	}
	return false;
}

async function handleKnowledgeRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
	organizationId: string,
	actorUserId: string | null,
): Promise<boolean> {
	if (path === "/api/knowledge/questions" && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(
			response,
			200,
			await listLibraryQuestions(database, organizationId, url.searchParams.get("industry"), parsePagination(url)),
		);
		return true;
	}
	if (path === "/api/knowledge/questions" && request.method === "POST") {
		json(response, 201, await createLibraryQuestion(database, organizationId, actorUserId, await readJson(request)));
		return true;
	}
	if (path === "/api/knowledge/export" && request.method === "GET") {
		const url = new URL(request.url ?? path, `http://${request.headers.host ?? "127.0.0.1"}`);
		json(response, 200, await exportKnowledge(database, organizationId, url.searchParams.get("industry")));
		return true;
	}
	if (path === "/api/knowledge/import" && request.method === "POST") {
		json(response, 200, await importKnowledge(database, organizationId, actorUserId, await readJson(request)));
		return true;
	}
	const question = routeMatch(path, /^\/api\/knowledge\/questions\/([^/]+)$/);
	if (question && request.method === "DELETE") {
		await archiveLibraryQuestion(database, organizationId, question[0]);
		json(response, 200, { archived: true });
		return true;
	}
	return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Authentication and public-route ordering are intentionally centralized in one request boundary.
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const startedAt = Date.now();
	const requestedTraceId = request.headers["x-request-id"];
	const traceId =
		typeof requestedTraceId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestedTraceId)
			? requestedTraceId
			: randomUUID();
	let requestOrganizationId: string | null = null;
	const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
	const path = requestUrl.pathname;
	response.setHeader("x-request-id", traceId);
	response.once("finish", () => {
		if (
			path === "/api/health" ||
			path.startsWith("/api/service-logs") ||
			/^\/api\/workbench\/sessions\/[^/]+\/events$/.test(path) ||
			isQuietDesktopRuntimePath(path)
		)
			return;
		apiLogger.info("http.request", `${request.method ?? "GET"} ${path}`, {
			organizationId: requestOrganizationId,
			traceId,
			metadata: {
				method: request.method ?? "GET",
				path,
				status: response.statusCode,
				durationMs: Date.now() - startedAt,
			},
		});
	});
	const allowedOrigins = new Set([
		process.env.GEO_ALLOWED_ORIGIN?.trim() || "http://127.0.0.1:3000",
		...(process.env.GEO_ALLOWED_ORIGINS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
		"tauri://localhost",
		"http://tauri.localhost",
		"https://tauri.localhost",
	]);
	if (request.headers.origin && allowedOrigins.has(request.headers.origin)) {
		response.setHeader("access-control-allow-origin", request.headers.origin);
		response.setHeader("access-control-allow-credentials", "true");
	}
	response.setHeader("access-control-allow-headers", "authorization,content-type,x-geo-client");
	response.setHeader("access-control-expose-headers", "x-request-id");
	response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	if (request.method === "OPTIONS") {
		response.writeHead(204);
		response.end();
		return;
	}
	const shared = routeMatch(path, /^\/share\/([^/]+)$/);
	if (shared && request.method === "GET") {
		const snapshot = await getSharedReport(database, shared[0]);
		if (!snapshot) return json(response, 404, { error: "分享链接不存在、已过期或已撤销" });
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" });
		response.end(renderReportHtml(snapshot));
		return;
	}
	if (path === "/api/auth/login" && request.method === "POST") {
		const result = await login(database, response, await readJson(request, 16 * 1024), loginClientAddress(request));
		requestOrganizationId = result.user.organizationId;
		json(response, 200, {
			user: result.user,
			sessionToken: request.headers["x-geo-client"] === "desktop" ? result.sessionToken : undefined,
		});
		return;
	}
	if (path === "/api/health")
		return json(response, 200, {
			status: "ok",
			captureAdapterVersion: ADAPTER_VERSION,
			database: process.env.DATABASE_URL ? "postgresql" : "pglite",
			analysisConfigured: (await getHRouterConfig(database)).configured,
			captureRunner: "cloud",
			objectStore,
			logService: await checkLogService(),
		});
	if (path.startsWith("/artifacts/")) {
		const identity = await authenticateRequest(database, request);
		if (!identity) return json(response, 401, { error: "请先登录" });
		requestOrganizationId = identity.organizationId;
		const artifactKey = decodeURIComponent(path.slice("/artifacts/".length));
		await authorizeArtifact(database, await principalForIdentity(database, identity), artifactKey);
		await serveArtifact(response, artifactKey);
		return;
	}
	const identity = await authenticateRequest(database, request);
	if (!identity) return json(response, 401, { error: "请先登录" });
	requestOrganizationId = identity.organizationId;
	if (path === "/api/auth/me" && request.method === "GET") return json(response, 200, { user: identity });
	if (path === "/api/auth/password" && request.method === "POST") {
		await changeOwnPassword(database, request, identity, await readJson(request, 16 * 1024));
		return json(response, 200, { changed: true });
	}
	if (path === "/api/auth/logout" && request.method === "POST") {
		await logout(database, request, response);
		return json(response, 200, { loggedOut: true });
	}
	if (path === "/api/organizations/select" && request.method === "POST") {
		const body = z.object({ organizationId: z.string().trim().min(1) }).parse(await readJson(request));
		return json(response, 200, { user: await selectOrganization(database, response, identity, body.organizationId) });
	}
	if (path === "/api/rbac/navigation" && request.method === "GET") {
		const isDesktop = request.headers["x-geo-client"] === "desktop";
		return json(
			response,
			200,
			await getDynamicNavigation(database, identity.permissions, identity.isSuperAdmin, isDesktop),
		);
	}
	await authorizeRequest(database, await principalForIdentity(database, identity), request.method ?? "GET", path);
	if (path === "/api/organizations" && request.method === "GET") {
		if (!identity.isSuperAdmin) return json(response, 403, { error: "只有系统超管可以查看全部机构" });
		return json(response, 200, await listOrganizations(database, parsePagination(requestUrl)));
	}
	if (path === "/api/organizations" && request.method === "POST") {
		if (!identity.isSuperAdmin) return json(response, 403, { error: "只有系统超管可以创建机构" });
		const value = await createOrganization(database, await readJson(request), identity.id);
		await auditRequest(database, identity, request.method, path);
		return json(response, 201, value);
	}
	const organizationPermissions = routeMatch(path, /^\/api\/organizations\/([^/]+)\/permissions$/);
	if (organizationPermissions && request.method === "PUT") {
		if (!identity.isSuperAdmin) return json(response, 403, { error: "只有系统超管可以配置机构授权" });
		const body = z.object({ permissionKeys: z.array(z.string()) }).parse(await readJson(request));
		await updateOrganizationPermissions(database, organizationPermissions[0], body.permissionKeys, identity.id);
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { saved: true });
	}
	const organizationStatus = routeMatch(path, /^\/api\/organizations\/([^/]+)\/status$/);
	if (organizationStatus && request.method === "PUT") {
		if (!identity.isSuperAdmin) return json(response, 403, { error: "只有系统超管可以封禁或解封机构" });
		await setOrganizationStatus(database, organizationStatus[0], await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { saved: true });
	}
	if (path.startsWith("/api/rbac/configuration")) {
		const actor = actorFromIdentity(identity);
		await requireSystemAdministrator(database, actor, identity.organizationId);
		if (path === "/api/rbac/configuration/policies" && request.method === "GET")
			return json(response, 200, await listPolicies(database, parsePagination(requestUrl)));
		if (path === "/api/rbac/configuration/permissions" && request.method === "PUT") {
			await savePermission(database, actor, identity.organizationId, await readJson(request));
			return json(response, 200, { saved: true });
		}
		if (path === "/api/rbac/configuration/policies" && request.method === "POST")
			return json(response, 201, await savePolicy(database, actor, identity.organizationId, await readJson(request)));
		const policy = routeMatch(path, /^\/api\/rbac\/configuration\/policies\/([^/]+)$/);
		if (policy && request.method === "PUT")
			return json(
				response,
				200,
				await savePolicy(database, actor, identity.organizationId, await readJson(request), policy[0]),
			);
		if (path === "/api/rbac/configuration/explain" && request.method === "POST")
			return json(
				response,
				200,
				await explainRequest(database, actor, identity.organizationId, await readJson(request)),
			);
	}
	if (path === "/api/rbac/catalog" && request.method === "GET")
		return json(response, 200, await getRbacCatalog(database, identity.organizationId));
	if (path === "/api/rbac/roles" && request.method === "GET")
		return json(response, 200, await listRoles(database, identity.organizationId, parsePagination(requestUrl)));
	if (path === "/api/rbac/roles" && request.method === "POST") {
		const value = await createRole(database, identity.organizationId, await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 201, value);
	}
	const role = routeMatch(path, /^\/api\/rbac\/roles\/([^/]+)$/);
	if (role && request.method === "PUT") {
		await updateRole(database, identity.organizationId, role[0], await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { saved: true });
	}
	if (role && request.method === "DELETE") {
		await deleteRole(database, identity.organizationId, role[0]);
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { deleted: true });
	}
	if (path === "/api/users/options" && request.method === "GET") {
		const kind = z.enum(["roles", "projects"]).parse(requestUrl.searchParams.get("kind") ?? "roles");
		return json(
			response,
			200,
			await listMemberOptions(database, identity.organizationId, kind, parsePagination(requestUrl), identity),
		);
	}
	const memberAction = routeMatch(path, /^\/api\/users\/([^/]+)\/(restore|password)$/);
	if (memberAction && request.method === "POST") {
		if (memberAction[1] === "restore") await restoreUser(database, identity.organizationId, memberAction[0], identity);
		else
			await resetMemberPassword(
				database,
				identity.organizationId,
				memberAction[0],
				await readJson(request, 16 * 1024),
				identity,
			);
		return json(response, 200, { saved: true });
	}
	if (path === "/api/users" && request.method === "GET")
		return json(
			response,
			200,
			await listUsers(database, identity.organizationId, parsePagination(requestUrl), identity),
		);
	if (path === "/api/audit-logs" && request.method === "GET")
		return json(response, 200, await listAuditLogs(database, identity.organizationId, parsePagination(requestUrl)));
	if (path === "/api/service-logs" && request.method === "GET")
		return json(response, 200, await getServiceLogs(requestUrl, identity.organizationId, identity.isSuperAdmin));
	if (path === "/api/service-logs/export.csv" && request.method === "GET") {
		response.writeHead(200, {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": 'attachment; filename="geo-service-logs.csv"',
		});
		response.end(`\uFEFF${await getServiceLogsCsv(requestUrl, identity.organizationId, identity.isSuperAdmin)}`);
		return;
	}
	if (path === "/api/service-logs/retention" && request.method === "POST") {
		const result = await applyServiceLogRetention(identity.organizationId, await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, result);
	}
	if (path === "/api/users" && request.method === "POST") {
		const value = await createUser(database, await readJson(request, 32 * 1024), identity.organizationId, identity);
		// Domain audit and account creation commit together; no second post-commit write may turn success into a 500.
		return json(response, 201, value);
	}
	const userAccess = routeMatch(path, /^\/api\/users\/([^/]+)\/access$/);
	if (userAccess && request.method === "PUT") {
		await updateUserAccess(database, identity.organizationId, userAccess[0], await readJson(request));
		await auditRequest(database, identity, request.method, path);
		return json(response, 200, { saved: true });
	}
	const user = routeMatch(path, /^\/api\/users\/([^/]+)$/);
	if (user && request.method === "DELETE") {
		await disableUser(database, user[0], identity.id, identity.organizationId, identity);
		return json(response, 200, { disabled: true });
	}

	const handled =
		(await handleProjectRoutes(request, response, path, identity)) ||
		(await handleProjectDataRoutes(request, response, path)) ||
		(await handleBatchTaskRoutes(request, response, path, identity)) ||
		(await handleWorkbenchRoutes(request, response, path, identity)) ||
		(await handleSettingsRoutes(request, response, path, identity.organizationId)) ||
		(await handleHRouterRoutes(request, response, path, identity.organizationId)) ||
		(await handleKnowledgeRoutes(request, response, path, identity.organizationId, identity.id));
	if (handled) {
		if (!isDesktopRuntimePlumbing(path)) await auditRequest(database, identity, request.method ?? "GET", path);
		return;
	}
	json(response, 404, { error: "接口不存在" });
}

const server = createServer((request, response) => {
	handle(request, response).catch((error) => {
		const traceId = String(response.getHeader("x-request-id") ?? randomUUID());
		apiLogger.error("request.failed", safeErrorMessage(error), {
			traceId,
			metadata: { method: request.method ?? "GET", path: new URL(request.url ?? "/", "http://local").pathname },
		});
		if (error instanceof HttpInputError && error.status === 429) response.setHeader("retry-after", "900");
		if (error instanceof HttpInputError && error.status === 413) response.setHeader("connection", "close");
		if (!response.headersSent) {
			const result = apiErrorResponse(error, traceId);
			json(response, result.status, result.body);
		} else response.end();
	});
});

server.listen(port, host, () => apiLogger.info("service.started", `GEO API 已启动：${host}:${port}`));
const scheduleTimer = setInterval(() => {
	processDueSchedules(database).catch((error) => apiLogger.error("schedule.failed", safeErrorMessage(error)));
}, 60_000);
scheduleTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		clearInterval(scheduleTimer);
		server.close(() => {
			void Promise.all([apiLogger.flush(), stopLocalWorkers?.()]).finally(() =>
				database.close().finally(() => process.exit(0)),
			);
		});
	});
