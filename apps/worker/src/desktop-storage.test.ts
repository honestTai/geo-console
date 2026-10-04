import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { type WorkspaceManifest, workspaceManifestSchema } from "@geo/core/desktop-workspace";
import { openMemorySqliteDatabase } from "@geo/core/sqlite";
import { expect, it, vi } from "vitest";
import type { Identity } from "./auth";
import { commitWorkspace, handleDesktopStorage, isCloudControlPath, readWorkspaceHead } from "./desktop-storage";
import { HttpInputError } from "./utils";

const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("./object-store", () => ({
	putArtifact: async (key: string, body: Uint8Array) => {
		if (objects.has(key)) throw new Error("immutable");
		objects.set(key, Buffer.from(body));
	},
	readArtifact: async (key: string) => {
		const body = objects.get(key);
		if (!body) throw new Error("missing");
		return { body };
	},
}));

function identity(id: string, org = "default"): Identity {
	return {
		id,
		organizationId: org,
		organizationSuspended: false,
		localBypass: false,
		principal: { active: true },
	} as Identity;
}
const empty: WorkspaceManifest = {
	format: "geo.desktop-workspace.sqlite.v1",
	files: [{ path: "workspace.sqlite", size: 0, chunks: [] }],
};

it("isolates account/organization heads, rejects missing chunks and performs idempotent CAS", async () => {
	const db = openMemorySqliteDatabase();
	try {
		const user = identity("one");
		expect(await readWorkspaceHead(db, user)).toEqual({ revision: 0, manifest: null });
		expect(await commitWorkspace(db, user, 0, empty)).toEqual({ revision: 1 });
		expect(await commitWorkspace(db, user, 0, empty)).toEqual({ revision: 1 });
		expect((await readWorkspaceHead(db, identity("two"))).revision).toBe(0);
		expect((await readWorkspaceHead(db, identity("one", "other"))).revision).toBe(0);
		const incomplete = workspaceManifestSchema.parse({
			...empty,
			files: [{ path: "workspace.sqlite", size: 4, chunks: ["a".repeat(64)] }],
		});
		await expect(commitWorkspace(db, user, 1, incomplete)).rejects.toMatchObject({ status: 400 });
		await expect(commitWorkspace(db, user, 0, incomplete)).rejects.toMatchObject({ status: 409 });
		expect((await readWorkspaceHead(db, user)).revision).toBe(1);
		await expect(readWorkspaceHead(db, { ...user, organizationSuspended: true })).rejects.toMatchObject({
			status: 403,
		});
	} finally {
		await db.close();
	}
});

it("HTTP storage refuses digest mismatches and never serves another user's object", async () => {
	const db = openMemorySqliteDatabase();
	const server = createServer((req, res) => {
		void handleDesktopStorage(db, req, res, identity(String(req.headers["x-test-user"] ?? "one"))).catch((error) => {
			res.writeHead(error instanceof HttpInputError ? error.status : 500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(error) }));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		const digest = createHash("sha256").update("test").digest("hex");
		const path = `/api/desktop-storage/objects/${digest}`;
		expect(
			(
				await fetch(origin + path, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ data: Buffer.from("wrong").toString("base64") }),
				})
			).status,
		).toBe(400);
		const upload = () =>
			fetch(origin + path, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ data: Buffer.from("test").toString("base64") }),
			});
		expect((await upload()).status).toBe(200);
		expect((await upload()).status).toBe(200);
		expect(await (await fetch(origin + path)).json()).toEqual({ data: Buffer.from("test").toString("base64") });
		expect((await fetch(origin + path, { headers: { "x-test-user": "two" } })).status).toBe(404);
		expect(
			await commitWorkspace(db, identity("one"), 0, {
				...empty,
				files: [{ path: "workspace.sqlite", size: 4, chunks: [digest] }],
			}),
		).toEqual({ revision: 1 });
		// Explicit oversized historical metadata fixture proves quota is checked before object upload.
		const scope = createHash("sha256")
			.update(JSON.stringify(["default", "two"]))
			.digest("hex");
		await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [
			`desktop-workspace:${scope}:object:${digest}`,
			{ key: "never-read", digest, size: 20 * 1024 ** 3 },
		]);
		const another = createHash("sha256").update("next").digest("hex");
		expect(
			(
				await fetch(`${origin}/api/desktop-storage/objects/${another}`, {
					method: "PUT",
					headers: { "content-type": "application/json", "x-test-user": "two" },
					body: JSON.stringify({ data: Buffer.from("next").toString("base64") }),
				})
			).status,
		).toBe(413);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await db.close();
	}
});

it("cloud control plane whitelist excludes all business execution", () => {
	for (const path of [
		"/api/projects",
		"/api/settings/hrouter",
		"/api/workbench/sessions/a/desktop/tools",
		"/api/reports",
		"/api/jobs",
	])
		expect(isCloudControlPath(path)).toBe(false);
	for (const path of ["/api/auth/me", "/api/users", "/api/desktop-storage/commit"])
		expect(isCloudControlPath(path)).toBe(true);
});
