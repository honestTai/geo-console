import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "@geo/core";
import {
	logLevels,
	redactLogText,
	type ServiceLogQuery,
	type ServiceLogQueryResult,
	type ServiceLogRow,
	sanitizeLogMetadata,
} from "@geo/logging";
import { z } from "zod";

const serviceNameSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const eventNameSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
const logInputSchema = z.object({
	organizationId: z.string().trim().min(1).max(160).nullable().optional(),
	service: serviceNameSchema,
	level: z.enum(logLevels),
	event: eventNameSchema,
	message: z.string().trim().min(1).max(2_000),
	traceId: z.string().trim().min(1).max(160).nullable().optional(),
	projectId: z.string().trim().min(1).max(160).nullable().optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
	occurredAt: z.string().datetime().optional(),
});
const ingestSchema = z.object({ logs: z.array(logInputSchema).min(1).max(100) });
const retentionSchema = z.object({
	organizationId: z.string().trim().min(1).max(160),
	olderThanDays: z.number().int().min(7).max(3_650),
});

const querySchema = z.object({
	organizationId: z.string().trim().min(1).max(160),
	includeSystem: z.enum(["true", "false"]).default("false"),
	service: serviceNameSchema.optional(),
	level: z.enum(logLevels).optional(),
	search: z.string().trim().max(200).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	cursor: z.string().max(1_000).optional(),
	page: z.coerce.number().int().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(1_000).default(100),
});

type LogCursor = { occurredAt: string; id: string };

function encodeCursor(cursor: LogCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | undefined): LogCursor | null {
	if (!value) return null;
	try {
		return z
			.object({ occurredAt: z.string().datetime(), id: z.string().min(1).max(160) })
			.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
	} catch {
		throw new Error("无效的日志分页游标");
	}
}

function normalizedRow(row: Record<string, unknown>): ServiceLogRow {
	return {
		id: String(row.id),
		organization_id: row.organization_id ? String(row.organization_id) : null,
		service: String(row.service),
		level: String(row.level) as ServiceLogRow["level"],
		event: String(row.event),
		message: String(row.message),
		trace_id: row.trace_id ? String(row.trace_id) : null,
		project_id: row.project_id ? String(row.project_id) : null,
		metadata:
			typeof row.metadata === "string"
				? (JSON.parse(row.metadata) as Record<string, unknown>)
				: ((row.metadata ?? {}) as Record<string, unknown>),
		occurred_at: new Date(String(row.occurred_at)).toISOString(),
	};
}

export async function ingestServiceLogs(database: Database, input: unknown): Promise<{ accepted: number }> {
	const data = ingestSchema.parse(input);
	await database.transaction(async (transaction) => {
		for (const item of data.logs) {
			await transaction.query(
				`INSERT INTO service_logs
				 (id,organization_id,service,level,event,message,trace_id,project_id,metadata,occurred_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
				[
					randomUUID(),
					item.organizationId ?? null,
					item.service,
					item.level,
					item.event,
					redactLogText(item.message),
					item.traceId ?? null,
					item.projectId ?? null,
					JSON.stringify(sanitizeLogMetadata(item.metadata)),
					item.occurredAt ?? new Date().toISOString(),
				],
			);
		}
	});
	return { accepted: data.logs.length };
}

function queryConditions(query: ServiceLogQuery): { conditions: string[]; params: unknown[] } {
	const params: unknown[] = [query.organizationId];
	const conditions = [query.includeSystem ? "(organization_id=$1 OR organization_id IS NULL)" : "organization_id=$1"];
	const add = (condition: (position: number) => string, value: unknown) => {
		params.push(value);
		conditions.push(condition(params.length));
	};
	if (query.service) add((position) => `service=$${position}`, query.service);
	if (query.level) add((position) => `level=$${position}`, query.level);
	if (query.from) add((position) => `occurred_at>=$${position}`, query.from);
	if (query.to) add((position) => `occurred_at<=$${position}`, query.to);
	if (query.search) {
		add(
			(position) =>
				`(message ILIKE $${position} OR event ILIKE $${position} OR trace_id ILIKE $${position} OR project_id ILIKE $${position})`,
			`%${query.search}%`,
		);
	}
	return { conditions, params };
}

export async function listServiceLogs(database: Database, input: ServiceLogQuery): Promise<ServiceLogQueryResult> {
	const query = { ...input, limit: Math.max(1, Math.min(1_000, input.limit ?? 100)) };
	const base = queryConditions(query);
	const conditions = [...base.conditions];
	const params = [...base.params];
	// 页码模式（工作台列表）用 OFFSET；游标模式（CSV 导出、增量拉取）保持不变
	const page = query.page && query.page >= 1 ? Math.trunc(query.page) : null;
	const cursor = page ? null : decodeCursor(query.cursor);
	if (cursor) {
		params.push(cursor.occurredAt, cursor.id);
		conditions.push(
			`(occurred_at<$${params.length - 1} OR (occurred_at=$${params.length - 1} AND id<$${params.length}))`,
		);
	}
	params.push(query.limit + 1);
	const limitPosition = params.length;
	if (page) params.push((page - 1) * query.limit);
	const rows = await database.query<Record<string, unknown>>(
		`SELECT id,organization_id,service,level,event,message,trace_id,project_id,metadata,occurred_at
		 FROM service_logs WHERE ${conditions.join(" AND ")}
		 ORDER BY occurred_at DESC,id DESC LIMIT $${limitPosition}${page ? ` OFFSET $${params.length}` : ""}`,
		params,
	);
	const counts = await database.query<{ level: string; count: number }>(
		`SELECT level,count(*)::int AS count FROM service_logs WHERE ${base.conditions.join(" AND ")} GROUP BY level`,
		base.params,
	);
	const visible = rows.rows.slice(0, query.limit).map(normalizedRow);
	const last = visible.at(-1);
	const levelCounts = Object.fromEntries(
		logLevels.map((level) => [level, counts.rows.find((row) => row.level === level)?.count ?? 0]),
	) as Record<(typeof logLevels)[number], number>;
	const total = Object.values(levelCounts).reduce((sum, count) => sum + count, 0);
	return {
		logs: visible,
		nextCursor:
			rows.rows.length > query.limit && last ? encodeCursor({ occurredAt: last.occurred_at, id: last.id }) : null,
		counts: levelCounts,
		total,
		page: page ?? 1,
		pageSize: query.limit,
		totalPages: Math.max(1, Math.ceil(total / query.limit)),
	};
}

export async function pruneOrganizationLogs(
	database: Database,
	organizationId: string,
	olderThanDays: number,
): Promise<{ deleted: number }> {
	const days = Math.max(7, Math.min(3_650, Math.trunc(olderThanDays)));
	const result = await database.query(
		"DELETE FROM service_logs WHERE organization_id=$1 AND occurred_at<now()-($2::text||' days')::interval",
		[organizationId, days],
	);
	await ingestServiceLogs(database, {
		logs: [
			{
				organizationId,
				service: "log-service",
				level: "info",
				event: "logs.retention_pruned",
				message: `已清理 ${days} 天前的运行日志`,
				metadata: { olderThanDays: days, deleted: result.affectedRows },
			},
		],
	});
	return { deleted: result.affectedRows };
}

export async function pruneAllExpiredLogs(database: Database, olderThanDays: number): Promise<number> {
	const days = Math.max(7, Math.min(3_650, Math.trunc(olderThanDays)));
	const result = await database.query(
		"DELETE FROM service_logs WHERE occurred_at<now()-($1::text||' days')::interval",
		[days],
	);
	return result.affectedRows;
}

function csvCell(value: unknown): string {
	let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
	if (/^[=+\-@]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

export async function serviceLogsCsv(database: Database, query: ServiceLogQuery): Promise<string> {
	const base = queryConditions({ ...query, cursor: undefined });
	const rows = (
		await database.query<Record<string, unknown>>(
			`SELECT id,organization_id,service,level,event,message,trace_id,project_id,metadata,occurred_at
			 FROM service_logs WHERE ${base.conditions.join(" AND ")}
			 ORDER BY occurred_at DESC,id DESC LIMIT 10000`,
			base.params,
		)
	).rows.map(normalizedRow);
	return [
		["时间", "级别", "服务", "事件", "消息", "Trace ID", "项目 ID", "元数据"],
		...rows.map((row) => [
			row.occurred_at,
			row.level,
			row.service,
			row.event,
			row.message,
			row.trace_id,
			row.project_id,
			row.metadata,
		]),
	]
		.map((row) => row.map(csvCell).join(","))
		.join("\r\n");
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.byteLength;
		if (length > 2_000_000) throw new Error("日志请求正文过大");
		chunks.push(Buffer.from(chunk));
	}
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, expectedToken: string | null): boolean {
	if (!expectedToken) return process.env.NODE_ENV !== "production";
	const header = request.headers.authorization;
	const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
	const expected = Buffer.from(expectedToken);
	const provided = Buffer.from(actual);
	return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function parsedQuery(url: URL): ServiceLogQuery {
	const data = querySchema.parse(Object.fromEntries(url.searchParams));
	return {
		organizationId: data.organizationId,
		includeSystem: data.includeSystem === "true",
		service: data.service,
		level: data.level,
		search: data.search,
		from: data.from,
		to: data.to,
		cursor: data.cursor,
		page: data.page,
		limit: data.limit,
	};
}

export function createLogServiceHandler(database: Database, token: string | null, retentionDays: number) {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Internal auth and the four bounded log operations stay in one auditable HTTP boundary.
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		if (url.pathname === "/health" && request.method === "GET") {
			const state = (
				await database.query<{ count: number; latest: string | null }>(
					"SELECT count(*)::int AS count,max(occurred_at) AS latest FROM service_logs",
				)
			).rows[0];
			return json(response, 200, {
				status: "ok",
				service: "log-service",
				retentionDays,
				storedLogs: state?.count ?? 0,
				latestAt: state?.latest ?? null,
			});
		}
		if (!authorized(request, token)) return json(response, 401, { error: "日志服务认证失败" });
		if (url.pathname === "/v1/logs" && request.method === "POST")
			return json(response, 202, await ingestServiceLogs(database, await readJson(request)));
		if (url.pathname === "/v1/logs" && request.method === "GET")
			return json(response, 200, await listServiceLogs(database, parsedQuery(url)));
		if (url.pathname === "/v1/logs/export.csv" && request.method === "GET") {
			response.writeHead(200, {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": 'attachment; filename="geo-service-logs.csv"',
			});
			response.end(`\uFEFF${await serviceLogsCsv(database, parsedQuery(url))}`);
			return;
		}
		if (url.pathname === "/v1/logs/retention" && request.method === "POST") {
			const data = retentionSchema.parse(await readJson(request));
			return json(response, 200, await pruneOrganizationLogs(database, data.organizationId, data.olderThanDays));
		}
		json(response, 404, { error: "日志服务接口不存在" });
	};
}

export function logServiceErrorStatus(error: unknown): number {
	return error instanceof z.ZodError || (error instanceof Error && /无效|过大/.test(error.message)) ? 400 : 500;
}
