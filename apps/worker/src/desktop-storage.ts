import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "@geo/core";
import { type WorkspaceManifest, workspaceManifestSchema } from "@geo/core/desktop-workspace";
import { z } from "zod";
import type { Identity } from "./auth";
import { putArtifact, readArtifact } from "./object-store";
import { HttpInputError, json, readJson, stableJson } from "./utils";

export const isCloudControlPath = (path: string): boolean =>
	["/api/auth/", "/api/organizations", "/api/users", "/api/rbac/", "/api/desktop-storage/"].some((prefix) =>
		prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`),
	);

function owner(identity: Identity): [string, string] {
	if (!identity.id || identity.localBypass || identity.organizationSuspended || !identity.principal.active)
		throw new HttpInputError("工作区存储需要有效的云端账号", 403);
	return [identity.organizationId, identity.id];
}

function namespace(identity: Identity): string {
	return `desktop-workspace:${createHash("sha256")
		.update(JSON.stringify(owner(identity)))
		.digest("hex")}`;
}

export async function readWorkspaceHead(database: Database, identity: Identity) {
	const row = (
		await database.query<{ value: { revision: number; manifest: WorkspaceManifest | null } }>(
			"SELECT value FROM settings WHERE key=$1",
			[`${namespace(identity)}:head`],
		)
	).rows[0];
	return row?.value ?? { revision: 0, manifest: null };
}

export async function commitWorkspace(
	database: Database,
	identity: Identity,
	baseRevision: number,
	manifest: WorkspaceManifest,
) {
	const prefix = namespace(identity);
	manifest = workspaceManifestSchema.parse(manifest);
	return database.transaction(async (tx) => {
		await tx.query(
			'INSERT INTO settings(key,value) VALUES($1,\'{"revision":0,"manifest":null}\'::jsonb) ON CONFLICT DO NOTHING',
			[`${prefix}:head`],
		);
		const row = (
			await tx.query<{ value: { revision: number; manifest: WorkspaceManifest | null } }>(
				"SELECT value FROM settings WHERE key=$1 FOR UPDATE",
				[`${prefix}:head`],
			)
		).rows[0];
		if (row.value.revision !== baseRevision) {
			// A lost commit response can be retried without manufacturing another revision.
			if (row.value.revision === baseRevision + 1 && stableJson(row.value.manifest) === stableJson(manifest))
				return { revision: row.value.revision };
			throw new HttpInputError("其他设备已有新版本。本机数据已保留，请先解决工作区同步冲突。", 409);
		}
		const objects = (
			await tx.query<{ value: { digest: string; size: number } }>(
				"SELECT value FROM settings WHERE key=ANY($1::text[])",
				[[...new Set(manifest.files.flatMap((f) => f.chunks))].map((digest) => `${prefix}:object:${digest}`)],
			)
		).rows;
		const sizes = new Map(objects.map((item) => [item.value.digest, item.value.size]));
		for (const file of manifest.files) {
			if (
				file.chunks.some((id) => !sizes.has(id)) ||
				file.chunks.reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0) !== file.size
			)
				throw new HttpInputError("工作区对象缺失或大小不匹配", 400);
		}
		const revision = baseRevision + 1;
		await tx.query("INSERT INTO settings(key,value) VALUES($1,$2::jsonb)", [
			`${prefix}:revision:${revision}`,
			JSON.stringify(manifest),
		]);
		await tx.query("UPDATE settings SET value=$2::jsonb,updated_at=now() WHERE key=$1", [
			`${prefix}:head`,
			JSON.stringify({ revision, manifest }),
		]);
		return { revision };
	});
}

export async function handleDesktopStorage(
	database: Database,
	request: IncomingMessage,
	response: ServerResponse,
	identity: Identity,
): Promise<boolean> {
	const path = new URL(request.url ?? "/", "http://local").pathname;
	if (!path.startsWith("/api/desktop-storage/")) return false;
	const keys = owner(identity);
	if (path === "/api/desktop-storage/bootstrap" && request.method === "GET") {
		json(response, 200, {
			user: identity,
			permissions: (await database.query("SELECT * FROM permissions ORDER BY key")).rows,
			policies: (await database.query("SELECT * FROM authorization_policies ORDER BY id")).rows,
			workspace: await readWorkspaceHead(database, identity),
		});
		return true;
	}
	if (path === "/api/desktop-storage/head" && request.method === "GET") {
		json(response, 200, await readWorkspaceHead(database, identity));
		return true;
	}
	if (path === "/api/desktop-storage/commit" && request.method === "POST") {
		const input = z
			.object({ baseRevision: z.number().int().nonnegative(), manifest: workspaceManifestSchema })
			.strict()
			.parse(await readJson(request, 4 * 1024 * 1024));
		json(response, 200, await commitWorkspace(database, identity, input.baseRevision, input.manifest));
		return true;
	}
	const match = path.match(/^\/api\/desktop-storage\/objects\/([a-f0-9]{64})$/);
	if (match && request.method === "PUT") {
		const input = z
			.object({ data: z.string().max(1_398_104) })
			.strict()
			.parse(await readJson(request, 1_500_000));
		const bytes = Buffer.from(input.data, "base64");
		if (bytes.length > 1_048_576 || createHash("sha256").update(bytes).digest("hex") !== match[1])
			throw new HttpInputError("工作区对象校验失败", 400);
		const scope = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
		const key = `desktop-workspaces/${scope}/${match[1]}`;
		await database.transaction(async (tx) => {
			const prefix = namespace(identity);
			await tx.query(
				'INSERT INTO settings(key,value) VALUES($1,\'{"revision":0,"manifest":null}\'::jsonb) ON CONFLICT DO NOTHING',
				[`${prefix}:head`],
			);
			await tx.query("SELECT value FROM settings WHERE key=$1 FOR UPDATE", [`${prefix}:head`]);
			if ((await tx.query("SELECT key FROM settings WHERE key=$1", [`${prefix}:object:${match[1]}`])).rows.length)
				return;
			const usage = (
				await tx.query<{ bytes: number; count: number }>(
					"SELECT COALESCE(sum((value->>'size')::bigint),0) AS bytes,count(*)::int AS count FROM settings WHERE key LIKE $1",
					[`${prefix}:object:%`],
				)
			).rows[0];
			if (Number(usage.bytes) + bytes.length > 20 * 1024 ** 3 || usage.count >= 25_000)
				throw new HttpInputError("工作区历史对象已达到存储配额，请联系管理员；本机数据不受影响", 413);
			try {
				await putArtifact(key, bytes, "application/octet-stream");
			} catch (error) {
				const existing = await readArtifact(key).catch(() => null);
				if (!existing || createHash("sha256").update(existing.body).digest("hex") !== match[1]) throw error;
			}
			await tx.query("INSERT INTO settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING", [
				`${prefix}:object:${match[1]}`,
				JSON.stringify({ digest: match[1], size: bytes.length, key }),
			]);
		});
		json(response, 200, { stored: true });
		return true;
	}
	if (match && request.method === "GET") {
		const row = (
			await database.query<{ value: { key: string } }>("SELECT value FROM settings WHERE key=$1", [
				`${namespace(identity)}:object:${match[1]}`,
			])
		).rows[0];
		if (!row) throw new HttpInputError("工作区对象不存在", 404);
		const artifact = await readArtifact(row.value.key);
		json(response, 200, { data: Buffer.from(artifact.body).toString("base64") });
		return true;
	}
	throw new HttpInputError("工作区存储接口不存在", 404);
}
