import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { PaginationInput } from "./pagination";
import { sha256 } from "./utils";

const importSchema = z.object({
	sourceType: z.enum(["ga4", "gsc", "form", "phone", "manual"]),
	fileName: z.string().trim().min(1).max(255),
	csv: z.string().min(1).max(5_000_000),
});

type AttributionEventInput = {
	metric: string;
	value: number;
	observedAt: string;
	landingUrl: string | null;
	externalId: string | null;
	channel: string | null;
};

const normalizedHeader = (value: string): string =>
	value
		.replace(/^\ufeff/, "")
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");

function valueFor(record: Record<string, string>, names: string[]): string | null {
	const accepted = new Set(names.map(normalizedHeader));
	const entry = Object.entries(record).find(([key]) => accepted.has(normalizedHeader(key)));
	return entry?.[1]?.trim() || null;
}

/** 只有日期没有时刻的行（GA4/GSC 日报）按中国时区当天零点记录，避免被当成 UTC 零点后显示成早上 8 点。 */
function observedAt(value: string | null, row: number): string {
	if (!value) throw new Error(`第 ${row} 行缺少日期 observed_at/date/日期`);
	const dayOnly = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/) ?? value.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
	const parsed = new Date(
		dayOnly ? `${dayOnly[1]}-${dayOnly[2].padStart(2, "0")}-${dayOnly[3].padStart(2, "0")}T00:00:00+08:00` : value,
	);
	if (Number.isNaN(parsed.getTime())) throw new Error(`第 ${row} 行日期无法解析：${value}`);
	return parsed.toISOString();
}

function numericValue(value: string | null, row: number, metric: string): number {
	if (value === null) throw new Error(`第 ${row} 行指标 ${metric} 缺少数值`);
	const parsed = Number(value.replace(/,/g, "").replace(/%$/, ""));
	if (!Number.isFinite(parsed)) throw new Error(`第 ${row} 行指标 ${metric} 的数值无效：${value}`);
	return parsed;
}

const wideMetrics: Array<{ metric: string; headers: string[] }> = [
	{ metric: "sessions", headers: ["sessions", "会话", "会话数"] },
	{ metric: "users", headers: ["users", "active users", "用户", "活跃用户"] },
	{ metric: "organic_clicks", headers: ["clicks", "organic clicks", "点击次数", "自然搜索点击"] },
	{ metric: "impressions", headers: ["impressions", "展示次数", "曝光"] },
	{ metric: "leads", headers: ["leads", "conversions", "key events", "线索", "转化", "关键事件"] },
	{ metric: "qualified_leads", headers: ["qualified leads", "有效线索", "合格线索"] },
	{ metric: "phone_calls", headers: ["phone calls", "calls", "电话咨询", "来电"] },
	{ metric: "revenue", headers: ["revenue", "收入", "成交金额"] },
];

function eventsFromRecord(record: Record<string, string>, index: number): AttributionEventInput[] {
	const row = index + 2;
	const timestamp = observedAt(valueFor(record, ["observed_at", "date", "日期", "时间"]), row);
	const landingUrl = valueFor(record, ["landing_url", "landing page", "page", "网页", "页面"]);
	const externalId = valueFor(record, ["external_id", "event id", "lead id", "事件ID", "线索ID"]);
	const channel = valueFor(record, ["channel", "default channel group", "渠道"]);
	const canonicalMetric = valueFor(record, ["metric", "指标"]);
	if (canonicalMetric) {
		const known = wideMetrics.find((item) =>
			item.headers.some((header) => normalizedHeader(header) === normalizedHeader(canonicalMetric)),
		);
		return [
			{
				metric: known?.metric ?? normalizedHeader(canonicalMetric),
				value: numericValue(valueFor(record, ["value", "数值"]), row, canonicalMetric),
				observedAt: timestamp,
				landingUrl,
				externalId,
				channel,
			},
		];
	}
	const events = wideMetrics.flatMap((item) => {
		const raw = valueFor(record, item.headers);
		return raw === null
			? []
			: [
					{
						metric: item.metric,
						value: numericValue(raw, row, item.metric),
						observedAt: timestamp,
						landingUrl,
						externalId,
						channel,
					},
				];
	});
	if (!events.length) throw new Error(`第 ${row} 行没有可识别的指标列`);
	return events;
}

export async function importAttributionCsv(
	database: Database,
	projectId: string,
	input: unknown,
): Promise<{ importId: string; rows: number; events: number }> {
	const data = importSchema.parse(input);
	const project = (await database.query("SELECT id FROM projects WHERE id=$1", [projectId])).rows[0];
	if (!project) throw new Error("客户项目不存在");
	const records = parse(data.csv, {
		bom: true,
		columns: true,
		skip_empty_lines: true,
		trim: true,
		relax_column_count: true,
	}) as Array<Record<string, string>>;
	if (!records.length) throw new Error("CSV 没有数据行");
	const events = records.flatMap(eventsFromRecord);
	const importId = randomUUID();
	const contentHash = sha256(`${data.sourceType}\n${data.csv}`);
	try {
		await database.transaction(async (transaction) => {
			await transaction.query(
				"INSERT INTO attribution_imports (id,project_id,source_type,file_name,row_count,content_hash) VALUES ($1,$2,$3,$4,$5,$6)",
				[importId, projectId, data.sourceType, data.fileName, records.length, contentHash],
			);
			for (const event of events)
				await transaction.query(
					`INSERT INTO attribution_events
					(id,project_id,import_id,source_type,metric,value,observed_at,landing_url,external_id,channel,metadata)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb)`,
					[
						randomUUID(),
						projectId,
						importId,
						data.sourceType,
						event.metric,
						event.value,
						event.observedAt,
						event.landingUrl,
						event.externalId,
						event.channel,
					],
				);
		});
	} catch (error) {
		if (error instanceof Error && /unique|duplicate/i.test(error.message))
			throw new Error("这份归因文件已经导入过，系统已阻止重复计数");
		throw error;
	}
	return { importId, rows: records.length, events: events.length };
}

export async function getAttribution(
	database: Database,
	projectId: string,
	input: PaginationInput,
): Promise<Record<string, unknown>> {
	const [summary, events, imports, eventCount, importCount] = await Promise.all([
		database.query(
			`SELECT source_type,metric,sum(value)::float8 AS value,min(observed_at) AS first_observed_at,
			 max(observed_at) AS last_observed_at,count(*)::int AS observations
			 FROM attribution_events WHERE project_id=$1 GROUP BY source_type,metric ORDER BY source_type,metric`,
			[projectId],
		),
		database.query(
			`SELECT id,source_type,metric,value,observed_at,landing_url,external_id,channel
				 FROM attribution_events WHERE project_id=$1 ORDER BY observed_at DESC,created_at DESC LIMIT $2 OFFSET $3`,
			[projectId, input.pageSize, input.offset],
		),
		database.query(
			`SELECT id,source_type,file_name,row_count,content_hash,imported_at FROM attribution_imports
				 WHERE project_id=$1 ORDER BY imported_at DESC LIMIT $2 OFFSET $3`,
			[projectId, input.pageSize, input.offset],
		),
		database.query<{ count: number }>("SELECT count(*)::int AS count FROM attribution_events WHERE project_id=$1", [
			projectId,
		]),
		database.query<{ count: number }>("SELECT count(*)::int AS count FROM attribution_imports WHERE project_id=$1", [
			projectId,
		]),
	]);
	return {
		summary: summary.rows,
		events: events.rows,
		imports: imports.rows,
		eventsPagination: {
			page: input.page,
			pageSize: input.pageSize,
			total: Number(eventCount.rows[0]?.count ?? 0),
			totalPages: Math.max(1, Math.ceil(Number(eventCount.rows[0]?.count ?? 0) / input.pageSize)),
		},
		importsPagination: {
			page: input.page,
			pageSize: input.pageSize,
			total: Number(importCount.rows[0]?.count ?? 0),
			totalPages: Math.max(1, Math.ceil(Number(importCount.rows[0]?.count ?? 0) / input.pageSize)),
		},
	};
}
