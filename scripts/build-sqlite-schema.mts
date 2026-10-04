/** Development-only schema compiler. It opens a NEW in-memory fixture, never an existing database.
 * The desktop ships the generated SQLite initialization schema, not this compiler or PG migrations.
 */
import { writeFile } from "node:fs/promises";
import { migrateDatabase, openMemoryDatabase } from "../packages/core/src/database";

const database = openMemoryDatabase();
try {
	await migrateDatabase(database);
	const columns=(await database.query<{table_name:string;column_name:string;data_type:string;udt_name:string;is_nullable:string;column_default:string|null}>(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name<>'geo_migrations' ORDER BY table_name,ordinal_position`)).rows;
	const constraints=(await database.query<{table_name:string;kind:string;definition:string}>(`SELECT c.relname AS table_name,co.contype AS kind,pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname<>'geo_migrations' ORDER BY c.relname,co.conname`)).rows;
	const indexes=(await database.query<{indexname:string;indexdef:string}>(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename<>'geo_migrations' AND indexname NOT IN(SELECT conname FROM pg_constraint)`)).rows;
	const seeds:Record<string,unknown[]>={};
	const enums=(await database.query<{name:string;label:string}>("SELECT t.typname AS name,e.enumlabel AS label FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid ORDER BY t.typname,e.enumsortorder")).rows;
	for(const table of ["organizations","permissions","permission_routes","authorization_policies","roles","role_permissions","organization_permissions"]) seeds[table]=(await database.query(`SELECT * FROM ${table}`)).rows;
	await writeFile(new URL("../packages/core/src/sqlite-schema-source.json",import.meta.url),JSON.stringify({columns,constraints,indexes,seeds,enums},null,"\t")+"\n");
	console.log(`Compiled schema for ${new Set(columns.map(c=>c.table_name)).size} empty SQLite tables; no business data exported.`);
} finally {await database.close();}
