import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Database, QueryResult } from "./database";
import { jsonContains, sqliteSql } from "./sqlite-dialect";
import { initializeSqliteGuards } from "./sqlite-guards";
import schema from "./sqlite-schema-source.json";

const formatVersion = 1;
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encode = (value: unknown): SQLInputValue =>
	value === null || value === undefined
		? null
		: value instanceof Date
			? value.toISOString()
			: typeof value === "boolean"
				? Number(value)
				: typeof value === "object"
					? JSON.stringify(value)
					: (value as SQLInputValue);
const jsonColumns = new Set(
	schema.columns.filter((c) => c.data_type === "jsonb").map((c) => `${c.table_name}.${c.column_name}`),
);
const booleanColumns = new Set(
	schema.columns.filter((c) => c.data_type === "boolean").map((c) => `${c.table_name}.${c.column_name}`),
);

function functions(client: DatabaseSync): void {
	client.function("now", () => new Date().toISOString());
	client.function("geo_json_contains", (value, subset) =>
		Number(jsonContains(JSON.parse(String(value)), JSON.parse(String(subset)))),
	);
	client.function("pg_advisory_xact_lock", (_first, _second) => 1); // BEGIN IMMEDIATE serializes all configuration writers.
	client.function("geo_regexp", (pattern, value) =>
		value === null ? 0 : Number(new RegExp(String(pattern)).test(String(value))),
	);
	client.function("geo_json_concat", (left, right) =>
		JSON.stringify([...JSON.parse(String(left)), ...JSON.parse(String(right))]),
	);
	client.function("geo_json_remove", (value, key) => {
		const result = JSON.parse(String(value));
		delete result[String(key)];
		return JSON.stringify(result);
	});
	client.function("geo_json_set", (value, path, replacement) => {
		const result = JSON.parse(String(value));
		const keys = String(path)
			.replace(/^\{|\}$/g, "")
			.split(",");
		let target = result;
		for (const key of keys.slice(0, -1)) {
			if (target?.[key] === undefined) return String(value);
			target = target[key];
		}
		target[keys.at(-1)!] = JSON.parse(String(replacement));
		return JSON.stringify(result);
	});
	client.function("geo_job_project", (payload) => {
		const value = JSON.parse(String(payload));
		if (value.projectId) return value.projectId;
		for (const [table, key] of [
			["agent_runs", "runId"],
			["semantic_parse_runs", "runId"],
			["agent_sessions", "sessionId"],
			["report_snapshots", "reportId"],
			["answer_analysis_runs", "analysisId"],
		]) {
			if (!value[key]) continue;
			const row = client.prepare(`SELECT project_id FROM ${table} WHERE id=?`).get(value[key]);
			if (row) return row.project_id;
		}
		return null;
	});
	client.function("geo_date_shift", (date, sign, multiplier, interval) => {
		const match = String(interval).match(/^(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week)s?$/);
		if (!match) throw new Error("Unsupported interval");
		const units: Record<string, number> = {
			second: 1000,
			minute: 60_000,
			hour: 3_600_000,
			day: 86_400_000,
			week: 604_800_000,
		};
		return new Date(
			Date.parse(String(date)) + (sign === "-" ? -1 : 1) * Number(multiplier) * Number(match[1]) * units[match[2]],
		).toISOString();
	});
}

function initialize(client: DatabaseSync): void {
	const version = Number(client.prepare("PRAGMA user_version").get()?.user_version);
	if (version === formatVersion) return;
	if (
		version !== 0 ||
		client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()
	)
		throw new Error("SQLite 工作区格式不受支持；不会迁移或覆盖已有数据库");
	client.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
	try {
		for (const table of new Set(schema.columns.map((c) => c.table_name))) {
			const definitions = schema.columns
				.filter((c) => c.table_name === table)
				.map((c) => {
					const type =
						c.data_type === "boolean" || /int/.test(c.data_type)
							? "INTEGER"
							: /real|double|numeric/.test(c.data_type)
								? "REAL"
								: "TEXT";
					const defaultValue = c.column_default === null ? "" : ` DEFAULT (${sqliteSql(c.column_default)})`;
					const labels = schema.enums
						.filter((e) => e.name === c.udt_name)
						.map((e) => `'${e.label.replaceAll("'", "''")}'`);
					const enumCheck = labels.length ? ` CHECK (${quoted(c.column_name)} IN (${labels.join(",")}))` : "";
					return `${quoted(c.column_name)} ${type}${c.is_nullable === "NO" ? " NOT NULL" : ""}${defaultValue}${enumCheck}${c.data_type === "jsonb" ? ` CHECK (${quoted(c.column_name)} IS NULL OR json_valid(${quoted(c.column_name)}))` : ""}`;
				});
			for (const c of schema.constraints.filter((c) => c.table_name === table))
				definitions.push(sqliteSql(c.definition));
			client.exec(`CREATE TABLE ${quoted(table)} (${definitions.join(",")}) STRICT`);
		}
		for (const index of schema.indexes) client.exec(sqliteSql(index.indexdef));
		for (const [table, rows] of Object.entries(schema.seeds))
			for (const row of rows as Record<string, unknown>[]) {
				const entries = Object.entries(row);
				client
					.prepare(
						`INSERT INTO ${quoted(table)} (${entries.map(([key]) => quoted(key)).join(",")}) VALUES(${entries.map(() => "?").join(",")})`,
					)
					.run(...entries.map(([, value]) => encode(value)));
			}
		initializeSqliteGuards(client);
		client.exec(`PRAGMA user_version=${formatVersion}; COMMIT`);
	} catch (error) {
		client.exec("ROLLBACK");
		throw error;
	}
}

type State = { client: DatabaseSync; tail: Promise<unknown>; closed: boolean; generation: number };
export class SqliteDatabase implements Database {
	readonly dialect = "sqlite";
	constructor(
		private readonly state: State,
		private readonly insideTransaction = false,
	) {}
	private schedule<T>(work: () => T | Promise<T>): Promise<T> {
		if (this.insideTransaction) return Promise.resolve().then(work);
		const result = this.state.tail.then(() => {
			if (this.state.closed) throw new Error("SQLite 工作区已关闭");
			return work();
		});
		this.state.tail = result.catch(() => undefined);
		return result;
	}
	async query<Row extends Record<string, unknown>>(source: string, params: unknown[] = []): Promise<QueryResult<Row>> {
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This boundary keeps bound execution, column decoding and error normalization under one serialized operation.
		return this.schedule(() => {
			const sql = sqliteSql(source);
			try {
				const statement = this.state.client.prepare(sql);
				statement.setAllowUnknownNamedParameters(true);
				const bindings = Object.fromEntries(params.map((value, index) => [`$${index + 1}`, encode(value)]));
				const columns = statement.columns();
				let rows: Record<string, unknown>[] = [];
				let affectedRows = 0;
				if (columns.length) {
					rows = statement.all(bindings).map((raw) => {
						const row: Record<string, unknown> = { ...raw };
						for (const column of columns) {
							const key = `${column.table}.${column.column}`;
							if (
								row[column.name] !== null &&
								(jsonColumns.has(key) ||
									(!column.table &&
										["roles", "permissions", "configured_permissions", "project_ids"].includes(column.name)))
							)
								row[column.name] = JSON.parse(String(row[column.name]));
							else if (
								row[column.name] !== null &&
								(booleanColumns.has(key) || (!column.table && ["archived", "stale", "eligible"].includes(column.name)))
							)
								row[column.name] = Boolean(row[column.name]);
						}
						return { ...row };
					});
					affectedRows = /^\s*SELECT\b/i.test(sql)
						? 0
						: Number(this.state.client.prepare("SELECT changes() AS n").get()?.n ?? 0);
				} else affectedRows = Number(statement.run(bindings).changes);
				if (affectedRows > 0 && !/^\s*SELECT\b/i.test(sql)) this.state.generation++;
				return { rows: rows as Row[], affectedRows };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code = message.includes("project_archived")
					? "PZ001"
					: message.includes("project_deleted")
						? "PZ002"
						: (error as { errcode?: number }).errcode === 2067
							? "23505"
							: undefined;
				throw Object.assign(new Error(`SQLite query failed: ${message}\n${sql}`, { cause: error }), { code });
			}
		});
	}
	exec(sql: string): Promise<void> {
		return this.schedule(() => {
			this.state.client.exec(sqliteSql(sql));
			this.state.generation++;
		});
	}
	transaction<T>(work: (database: Database) => Promise<T>): Promise<T> {
		if (this.insideTransaction) return work(this);
		return this.schedule(async () => {
			this.state.client.exec("BEGIN IMMEDIATE");
			try {
				const result = await work(new SqliteDatabase(this.state, true));
				this.state.client.exec("COMMIT");
				return result;
			} catch (error) {
				this.state.client.exec("ROLLBACK");
				throw error;
			}
		});
	}
	get generation(): number {
		return this.state.generation;
	}
	snapshot(): Promise<Blob> {
		return this.schedule(() => new Blob([new Uint8Array(this.state.client.serialize())]));
	}
	close(): Promise<void> {
		return this.schedule(() => {
			this.state.client.close();
			this.state.closed = true;
		});
	}
}

export function openMemorySqliteDatabase(): SqliteDatabase {
	const client = new DatabaseSync(":memory:");
	functions(client);
	initialize(client);
	client.exec("PRAGMA foreign_keys=ON");
	return new SqliteDatabase({ client, tail: Promise.resolve(), closed: false, generation: 0 });
}

/** Only a new SQLite-format workspace can be initialized/restored. No PostgreSQL reader or migration runner. */
export async function openDesktopDatabase(file: string, restore?: Blob): Promise<SqliteDatabase> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	if (restore) {
		const bytes = Buffer.from(await restore.arrayBuffer());
		if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0")
			throw new Error("只接受本产品的 SQLite 工作区，不支持旧数据库导入");
		const temporary = `${file}.${randomUUID()}.restore`;
		try {
			await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
			const candidate = new DatabaseSync(temporary, { readOnly: true });
			try {
				if (Number(candidate.prepare("PRAGMA user_version").get()?.user_version) !== formatVersion)
					throw new Error("SQLite 工作区格式不受支持");
				if (candidate.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
					throw new Error("SQLite 工作区完整性校验失败");
				const tables = new Set(
					candidate
						.prepare("SELECT name FROM sqlite_master WHERE type='table'")
						.all()
						.map((row) => row.name),
				);
				if (schema.columns.some((column) => !tables.has(column.table_name))) throw new Error("SQLite 工作区缺少业务表");
			} finally {
				candidate.close();
			}
			// An atomic no-replace install, including when another process created the destination.
			await link(temporary, file);
		} finally {
			await rm(temporary, { force: true });
		}
	}
	const client = new DatabaseSync(file);
	functions(client);
	try {
		await chmod(file, 0o600);
		initialize(client);
		client.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
	} catch (error) {
		client.close();
		throw error;
	}
	return new SqliteDatabase({ client, tail: Promise.resolve(), closed: false, generation: 0 });
}
