import { readFile } from "node:fs/promises";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

export type StructuredLogInput = {
	organizationId?: string | null;
	service: string;
	level: LogLevel;
	event: string;
	message: string;
	traceId?: string | null;
	projectId?: string | null;
	metadata?: Record<string, unknown>;
	occurredAt?: string;
};

export type ServiceLogRow = {
	id: string;
	organization_id: string | null;
	service: string;
	level: LogLevel;
	event: string;
	message: string;
	trace_id: string | null;
	project_id: string | null;
	metadata: Record<string, unknown>;
	occurred_at: string;
};

export type ServiceLogQuery = {
	organizationId: string;
	includeSystem?: boolean;
	service?: string;
	level?: LogLevel;
	search?: string;
	from?: string;
	to?: string;
	cursor?: string;
	limit?: number;
};

export type ServiceLogQueryResult = {
	logs: ServiceLogRow[];
	nextCursor: string | null;
	counts: Record<LogLevel, number>;
};

const sensitiveKey =
	/(?:authorization|cookie|password|secret|token|api.?key|credential|ciphertext|auth.?tag|answer.?text|content.?text|raw.?response)/i;

export function redactLogText(value: string, maxLength = 2_000): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
		.replace(/([?&](?:key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
		.slice(0, maxLength);
}

function sanitizeValue(value: unknown, depth: number): unknown {
	if (depth > 4) return "[TRUNCATED]";
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return redactLogText(value, 500);
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
	if (!value || typeof value !== "object") return String(value).slice(0, 200);
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.slice(0, 40)
			.map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1)]),
	);
}

export function sanitizeLogMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
	return (sanitizeValue(value ?? {}, 0) ?? {}) as Record<string, unknown>;
}

export function safeErrorMessage(error: unknown): string {
	return redactLogText(error instanceof Error ? error.message : String(error || "未知错误"));
}

async function logServiceToken(): Promise<string | null> {
	const fromEnvironment = process.env.GEO_LOG_SERVICE_TOKEN?.trim();
	if (fromEnvironment) return fromEnvironment;
	const file = process.env.GEO_LOG_SERVICE_TOKEN_FILE?.trim();
	return file ? (await readFile(file, "utf8")).trim() || null : null;
}

export class LogServiceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LogServiceUnavailableError";
	}
}

async function serviceRequest(path: string, init: RequestInit = {}): Promise<Response> {
	const baseUrl = process.env.GEO_LOG_SERVICE_URL?.trim().replace(/\/$/, "");
	if (!baseUrl) throw new LogServiceUnavailableError("日志服务未配置");
	const token = await logServiceToken();
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		signal: AbortSignal.timeout(5_000),
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...init.headers,
		},
	}).catch(() => {
		throw new LogServiceUnavailableError("无法连接日志服务");
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new LogServiceUnavailableError(body.error ?? `日志服务请求失败（HTTP ${response.status}）`);
	}
	return response;
}

export async function checkLogService(): Promise<Record<string, unknown>> {
	const baseUrl = process.env.GEO_LOG_SERVICE_URL?.trim().replace(/\/$/, "");
	if (!baseUrl) return { status: "unconfigured" };
	try {
		const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
		return response.ok
			? ((await response.json()) as Record<string, unknown>)
			: { status: "unavailable", httpStatus: response.status };
	} catch {
		return { status: "unavailable" };
	}
}

function queryString(query: ServiceLogQuery): string {
	const params = new URLSearchParams({ organizationId: query.organizationId });
	if (query.includeSystem) params.set("includeSystem", "true");
	if (query.service) params.set("service", query.service);
	if (query.level) params.set("level", query.level);
	if (query.search) params.set("search", query.search);
	if (query.from) params.set("from", query.from);
	if (query.to) params.set("to", query.to);
	if (query.cursor) params.set("cursor", query.cursor);
	if (query.limit) params.set("limit", String(query.limit));
	return params.toString();
}

export async function queryServiceLogs(query: ServiceLogQuery): Promise<ServiceLogQueryResult> {
	return (await (await serviceRequest(`/v1/logs?${queryString(query)}`)).json()) as ServiceLogQueryResult;
}

export async function exportServiceLogsCsv(query: ServiceLogQuery): Promise<string> {
	return (await serviceRequest(`/v1/logs/export.csv?${queryString(query)}`)).text();
}

export async function pruneServiceLogs(organizationId: string, olderThanDays: number): Promise<{ deleted: number }> {
	return (await (
		await serviceRequest("/v1/logs/retention", {
			method: "POST",
			body: JSON.stringify({ organizationId, olderThanDays }),
		})
	).json()) as { deleted: number };
}

type LogContext = Omit<StructuredLogInput, "service" | "level" | "event" | "message">;

export class StructuredLogger {
	private readonly queue: StructuredLogInput[] = [];
	private flushing = false;
	private retryTimer: NodeJS.Timeout | null = null;

	constructor(private readonly service: string) {}

	debug(event: string, message: string, context: LogContext = {}): void {
		this.enqueue("debug", event, message, context);
	}

	info(event: string, message: string, context: LogContext = {}): void {
		this.enqueue("info", event, message, context);
	}

	warn(event: string, message: string, context: LogContext = {}): void {
		this.enqueue("warn", event, message, context);
	}

	error(event: string, message: string, context: LogContext = {}): void {
		this.enqueue("error", event, message, context);
	}

	private enqueue(level: LogLevel, event: string, message: string, context: LogContext): void {
		const entry: StructuredLogInput = {
			...context,
			service: this.service,
			level,
			event: event.slice(0, 120),
			message: redactLogText(message),
			metadata: sanitizeLogMetadata(context.metadata),
			occurredAt: context.occurredAt ?? new Date().toISOString(),
		};
		const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
		consoleMethod(JSON.stringify(entry));
		if (!process.env.GEO_LOG_SERVICE_URL?.trim()) return;
		this.queue.push(entry);
		if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
		void this.flush();
	}

	async flush(): Promise<void> {
		if (this.flushing || this.queue.length === 0) return;
		this.flushing = true;
		const batch = this.queue.splice(0, 50);
		try {
			await serviceRequest("/v1/logs", { method: "POST", body: JSON.stringify({ logs: batch }) });
			if (this.retryTimer) clearTimeout(this.retryTimer);
			this.retryTimer = null;
		} catch {
			this.queue.unshift(...batch);
			if (!this.retryTimer) {
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					void this.flush();
				}, 5_000);
				this.retryTimer.unref();
			}
		} finally {
			this.flushing = false;
			if (!this.retryTimer && this.queue.length > 0) void this.flush();
		}
	}
}
