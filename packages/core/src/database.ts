import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import pg from "pg";
import { geoPaths } from "./paths";

export type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
	rows: Row[];
	affectedRows: number;
};

export interface Database {
	query<Row extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<QueryResult<Row>>;
	exec(sql: string): Promise<void>;
	transaction<T>(work: (database: Database) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

class PGliteDatabase implements Database {
	constructor(private readonly client: PGliteInterface | Transaction) {}

	async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
		const result = await this.client.query<Row>(sql, params);
		return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
	}
	async exec(sql: string): Promise<void> {
		await this.client.exec(sql);
	}

	async transaction<T>(work: (database: Database) => Promise<T>): Promise<T> {
		if (!(this.client instanceof PGlite)) return work(this);
		return this.client.transaction(async (transaction) => work(new PGliteDatabase(transaction)));
	}

	async close(): Promise<void> {
		if (this.client instanceof PGlite) await this.client.close();
	}
}

class PostgresDatabase implements Database {
	constructor(
		private readonly pool: pg.Pool,
		private readonly connection?: pg.PoolClient,
	) {}

	async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
		const result = await (this.connection ?? this.pool).query<Row>(sql, params);
		return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
	}
	async exec(sql: string): Promise<void> {
		await (this.connection ?? this.pool).query(sql);
	}

	async transaction<T>(work: (database: Database) => Promise<T>): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			const result = await work(new PostgresDatabase(this.pool, connection));
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK");
			throw error;
		} finally {
			connection.release();
		}
	}

	async close(): Promise<void> {
		if (!this.connection) await this.pool.end();
	}
}

export function postgresPoolConfig(databaseUrl: string, password?: string): pg.PoolConfig {
	const connection = new URL(databaseUrl);
	if (password) connection.password = password;
	return { connectionString: connection.toString() };
}

export async function openDatabase(): Promise<Database> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (databaseUrl) {
		const passwordFile = process.env.PGPASSWORD_FILE?.trim();
		const password = passwordFile ? (await readFile(passwordFile, "utf8")).trim() : undefined;
		return new PostgresDatabase(new pg.Pool(postgresPoolConfig(databaseUrl, password)));
	}
	await mkdir(geoPaths.database, { recursive: true });
	return new PGliteDatabase(new PGlite(geoPaths.database));
}

export function openMemoryDatabase(): Database {
	return new PGliteDatabase(new PGlite());
}

export async function migrateDatabase(database: Database): Promise<void> {
	await database.query(`CREATE TABLE IF NOT EXISTS geo_migrations (
		name text PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`);
	const migrationDirectory = resolve(fileURLToPath(new URL("../migrations", import.meta.url)));
	const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
	for (const name of migrations) {
		const existing = await database.query("SELECT name FROM geo_migrations WHERE name = $1", [name]);
		if (existing.rows.length > 0) continue;
		const sql = await readFile(resolve(migrationDirectory, name), "utf8");
		await database.transaction(async (transaction) => {
			await transaction.exec(sql);
			await transaction.query("INSERT INTO geo_migrations (name) VALUES ($1)", [name]);
		});
	}
}
