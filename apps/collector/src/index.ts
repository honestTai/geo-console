import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { geoPaths } from "@geo/core";
import { type CaptureFailureCode, type CaptureStatus, type EngineSurface, queryCaptureSchema } from "@geo/evidence";
import { CaptureAdapterError, currentCollectorVersion } from "@geo/surface-adapters";
import { type BrowserContext, chromium, type Page } from "playwright";
import { adapters } from "./adapters";
import { matchBrands } from "./brand-matcher";

type Job = {
	id: string;
	payload: {
		projectId: string;
		batchId: string;
		promptId: string;
		prompt: string;
		platform: EngineSurface;
		attempt: number;
		region: string;
		locale: string;
		brands: Array<{ id: string; name: string; aliases: string[] }>;
	};
};

const workerUrl = (process.env.GEO_WORKER_URL?.trim() || "http://127.0.0.1:3010").replace(/\/$/, "");
const headless = process.env.GEO_COLLECTOR_HEADLESS === "true";
const contexts = new Map<EngineSurface, BrowserContext>();
let running = false;

async function browserExecutable(): Promise<string> {
	const candidates = [
		process.env.GEO_CHROME_PATH?.trim(),
		chromium.executablePath(),
		process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
		process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next configured, bundled, or system browser path.
		}
	}
	throw new Error("没有可用的 Chrome/Chromium；请设置 GEO_CHROME_PATH 或安装 Playwright Chromium");
}

async function readToken(): Promise<string> {
	if (process.env.GEO_COLLECTOR_TOKEN?.trim()) return process.env.GEO_COLLECTOR_TOKEN.trim();
	try {
		const config = JSON.parse(await readFile(join(geoPaths.root, "collector.json"), "utf8")) as { token?: string };
		if (config.token) return config.token;
	} catch {
		/* setup will create the file */
	}
	throw new Error("Collector 尚未配对，请先运行 pnpm geo setup");
}

const token = await readToken();

async function api<T>(path: string, body: unknown = {}): Promise<T> {
	const response = await fetch(`${workerUrl}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const value = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error((value as { error?: string }).error ?? `Worker HTTP ${response.status}`);
	return value as T;
}

async function getContext(platform: EngineSurface): Promise<BrowserContext> {
	const existing = contexts.get(platform);
	if (existing) return existing;
	const context = await chromium.launchPersistentContext(join(geoPaths.browserProfiles, platform), {
		executablePath: await browserExecutable(),
		headless,
		viewport: { width: 1440, height: 1000 },
		locale: "zh-CN",
		colorScheme: "light",
		args: ["--disable-blink-features=AutomationControlled"],
	});
	contexts.set(platform, context);
	return context;
}

function statusForFailure(code: CaptureFailureCode): CaptureStatus {
	if (code === "login_expired") return "login_required";
	if (code === "verification_required") return "challenge_required";
	if (code === "rate_limited") return "rate_limited";
	if (code === "page_contract_changed") return "page_contract_changed";
	if (code === "answer_timeout") return "timeout";
	if (code === "no_answer") return "no_answer";
	return "failed";
}

async function captureJob(job: Job, nodeId: string): Promise<void> {
	const adapter = adapters[job.payload.platform];
	const context = await getContext(job.payload.platform);
	const page: Page = await context.newPage();
	const captureId = randomUUID();
	let screenshotBase64: string | undefined;
	const leaseRenewal = setInterval(() => {
		void api(`/api/collector/jobs/${job.id}/renew`).catch((error) =>
			console.error("Collector lease renewal:", error instanceof Error ? error.message : error),
		);
	}, 45_000);
	try {
		const session = await adapter.checkSession(page);
		if (session === "login_required") throw new CaptureAdapterError("login_expired", `${adapter.displayName} 尚未登录`);
		if (session === "challenge_required")
			throw new CaptureAdapterError("verification_required", `${adapter.displayName} 要求安全验证`);
		await adapter.startConversation(page);
		await adapter.submitQuestion(page, job.payload.prompt);
		await adapter.waitForAnswer(page, 120_000);
		const result = await adapter.extractAnswer(page);
		const screenshot = await page.screenshot({ fullPage: true, type: "png" });
		screenshotBase64 = screenshot.toString("base64");
		const capture = queryCaptureSchema.parse({
			schemaVersion: "geo.query-capture.v1",
			captureId,
			jobId: job.id,
			projectId: job.payload.projectId,
			promptId: job.payload.promptId,
			prompt: job.payload.prompt,
			engine: job.payload.platform,
			captureMode: "consumer_surface",
			attempt: job.payload.attempt,
			capturedAt: new Date().toISOString(),
			locale: job.payload.locale,
			region: job.payload.region,
			status: "complete",
			answerText: result.answerText,
			brandMatches: matchBrands(result.answerText, job.payload.brands),
			sources: result.sources,
			queryFanOut: result.queryFanOut,
			evidence: {
				captureNodeId: nodeId,
				screenshotObjectKey: `captures/${job.payload.projectId}/${captureId}.png`,
				traceObjectKey: null,
				pageUrl: result.pageUrl,
			},
			adapterVersion: adapter.version,
			contentHash: createHash("sha256").update(result.answerText).digest("hex"),
			failureCode: null,
			failureMessage: null,
		});
		await api(`/api/collector/jobs/${job.id}/result`, { capture, screenshotBase64 });
	} catch (error) {
		const failureCode: CaptureFailureCode = error instanceof CaptureAdapterError ? error.code : "unknown";
		const failureMessage = error instanceof Error ? error.message : "未知采集错误";
		try {
			screenshotBase64 = (await page.screenshot({ fullPage: true, type: "png" })).toString("base64");
		} catch {
			/* Page may already be gone. */
		}
		const capture = queryCaptureSchema.parse({
			schemaVersion: "geo.query-capture.v1",
			captureId,
			jobId: job.id,
			projectId: job.payload.projectId,
			promptId: job.payload.promptId,
			prompt: job.payload.prompt,
			engine: job.payload.platform,
			captureMode: "consumer_surface",
			attempt: job.payload.attempt,
			capturedAt: new Date().toISOString(),
			locale: job.payload.locale,
			region: job.payload.region,
			status: statusForFailure(failureCode),
			answerText: null,
			brandMatches: [],
			sources: [],
			queryFanOut: [],
			evidence: {
				captureNodeId: nodeId,
				screenshotObjectKey: screenshotBase64 ? `captures/${job.payload.projectId}/${captureId}.png` : null,
				traceObjectKey: null,
				pageUrl: page.url() || adapter.consumerUrl,
			},
			adapterVersion: adapter.version,
			contentHash: null,
			failureCode,
			failureMessage,
		});
		await api(`/api/collector/jobs/${job.id}/result`, { capture, screenshotBase64 });
	} finally {
		clearInterval(leaseRenewal);
		await page.close().catch(() => undefined);
	}
}

async function poll(): Promise<void> {
	if (running) return;
	running = true;
	try {
		const next = await api<{ nodeId: string; job: Job | null }>("/api/collector/jobs/next");
		if (next.job) await captureJob(next.job, next.nodeId);
	} catch (error) {
		console.error("Collector:", error instanceof Error ? error.message : error);
	} finally {
		running = false;
	}
}

const controlServer = createServer(async (request, response) => {
	response.setHeader("access-control-allow-origin", "http://127.0.0.1:3000");
	response.setHeader("content-type", "application/json; charset=utf-8");
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1:3020");
		const login = url.pathname.match(/^\/login\/(deepseek|kimi)$/)?.[1] as EngineSurface | undefined;
		if (login) {
			const context = await getContext(login);
			await adapters[login].openLogin(context);
			response.end(JSON.stringify({ opened: true }));
			return;
		}
		if (url.pathname === "/status") {
			const statuses: Record<string, string> = {};
			const errors: Record<string, string> = {};
			for (const platform of ["deepseek", "kimi"] as const) {
				try {
					const context = await getContext(platform);
					const page = context.pages()[0] ?? (await context.newPage());
					statuses[platform] = await adapters[platform].checkSession(page);
				} catch (error) {
					statuses[platform] = "unavailable";
					errors[platform] = error instanceof Error ? error.message : "未知浏览器错误";
				}
			}
			response.end(JSON.stringify({ running, platforms: statuses, errors }));
			return;
		}
		response.statusCode = 404;
		response.end(JSON.stringify({ error: "接口不存在" }));
	} catch (error) {
		response.statusCode = 500;
		response.end(JSON.stringify({ error: error instanceof Error ? error.message : "未知错误" }));
	}
});

controlServer.listen(3020, "127.0.0.1", () => console.log("GEO Collector control: http://127.0.0.1:3020"));
setInterval(poll, 5000).unref();
setInterval(
	() =>
		api("/api/collector/heartbeat", {
			version: currentCollectorVersion,
			capabilities: Object.keys(adapters),
		}).catch(() => undefined),
	30_000,
).unref();
await poll();

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, async () => {
		controlServer.close();
		await Promise.all([...contexts.values()].map((context) => context.close()));
		process.exit(0);
	});
