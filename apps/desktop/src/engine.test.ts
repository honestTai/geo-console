/** Isolated subprocess integration. All identities/providers here are explicit test fixtures. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Identity } from "@geo/worker/desktop-identity";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import schema from "../../../packages/core/src/sqlite-schema-source.json";
import type { WorkspaceHead } from "./workspace-sync";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const token = "a".repeat(64);
const permissions = schema.seeds.permissions.map((row) => row.key);
const identity: Identity = {
	id: "desktop-test-user",
	email: "fixture@example.test",
	displayName: "Fixture",
	role: "admin",
	homeOrganizationId: "default",
	organizationId: "default",
	organizationName: "Test",
	organizationSuspended: false,
	isSuperAdmin: false,
	localBypass: false,
	roles: [],
	permissions,
	allProjects: false,
	projectIds: [],
	authorizationRevision: "fixture-1",
	principal: {
		actor: { kind: "user", userId: "desktop-test-user" },
		userId: "desktop-test-user",
		organizationId: "default",
		homeOrganizationId: "default",
		active: true,
		organizationSuspended: false,
		systemAdmin: false,
		permissions,
		configuredPermissions: permissions,
		roles: [],
		projects: { all: false, ids: [] },
		revision: "fixture-1",
		credentialVersion: 1,
	},
};
let root: string;
const children: ChildProcessWithoutNullStreams[] = [];
let head: WorkspaceHead = { revision: 0, manifest: null };
const objects = new Map<string, string>();
const cloudPaths: string[] = [];
const modelRequests: unknown[] = [];
const modelServer = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += String(chunk);
	modelRequests.push(JSON.parse(body));
	const item = {
		id: "msg_fixture",
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Local model integration verified", annotations: [] }],
	};
	const response = {
		id: "resp_fixture",
		object: "response",
		created_at: 1,
		model: "gpt-test",
		status: "completed",
		output: [item],
		usage: {
			input_tokens: 12,
			output_tokens: 5,
			total_tokens: 17,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	res.writeHead(200, { "content-type": "text/event-stream" });
	const events = [
		{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: item.content[0].text,
		},
		{
			type: "response.output_text.done",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			text: item.content[0].text,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	for (const [sequence_number, event] of events.entries())
		res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
	res.end();
});

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "geo-engine-test-"));
	modelServer.listen(0, "127.0.0.1");
	await once(modelServer, "listening");
	await symlink(
		join(repo, "apps/worker/node_modules"),
		join(root, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	await build({
		entryPoints: [join(repo, "apps/desktop/src/engine.ts")],
		outfile: join(root, "engine.mjs"),
		bundle: true,
		platform: "node",
		target: "node24",
		format: "esm",
		external: ["playwright", "playwright-core"],
		banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' },
		plugins: [
			{
				name: "sqlite-only",
				setup(builder) {
					builder.onResolve({ filter: /^@geo\/core$/ }, () => ({
						path: join(repo, "packages/core/src/desktop-index.ts"),
					}));
					builder.onResolve({ filter: /^(pg|@electric-sql\/pglite)(\/|$)/ }, () => {
						throw new Error("Server database entered desktop bundle");
					});
				},
			},
		],
	});
}, 30_000);
afterAll(async () => {
	for (const child of children)
		if (child.exitCode === null) {
			child.kill();
			await once(child, "exit");
		}
	await new Promise<void>((resolve) => modelServer.close(() => resolve()));
	if (root) await rm(root, { recursive: true, force: true });
});

async function start(dataRoot: string) {
	const child = spawn(
		process.env.GEO_TEST_NODE_BINARY ?? process.execPath,
		[process.env.GEO_TEST_ENGINE_BUNDLE ?? join(root, "engine.mjs")],
		{
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				USERPROFILE: process.env.USERPROFILE,
				SystemRoot: process.env.SystemRoot,
				TMPDIR: process.env.TMPDIR,
				NODE_ENV: "test",
			},
			stdio: "pipe",
		},
	);
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += String(data);
	});
	const lines = createInterface({ input: child.stdout });
	const ready = new Promise<number>((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`engine exited ${code}: ${stderr}`)));
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This isolated broker fixture asserts every allowed cloud frame in one place.
		lines.on("line", (line) => {
			const frame = JSON.parse(line);
			if (frame.kind === "ready") resolve(frame.port);
			if (frame.kind === "fatal") reject(new Error(`${frame.error}\n${stderr}`));
			if (frame.kind !== "cloud") return;
			cloudPaths.push(frame.path);
			let body: unknown;
			let status = 200;
			if (frame.path === "/api/desktop-storage/bootstrap")
				body = {
					user: identity,
					permissions: schema.seeds.permissions,
					policies: schema.seeds.authorization_policies,
					workspace: head,
				};
			else if (frame.path === "/api/auth/me") body = { user: identity };
			else if (frame.path === "/api/desktop-storage/head") body = head;
			else if (frame.path === "/api/desktop-storage/commit") {
				if (frame.body.baseRevision === head.revision)
					head = { revision: head.revision + 1, manifest: frame.body.manifest };
				else if (
					frame.body.baseRevision + 1 !== head.revision ||
					JSON.stringify(frame.body.manifest) !== JSON.stringify(head.manifest)
				)
					status = 409;
				body = { revision: head.revision };
			} else if (/^\/api\/desktop-storage\/objects\/[a-f0-9]{64}$/.test(frame.path)) {
				if (frame.method === "PUT") {
					objects.set(frame.path, frame.body.data);
					body = { stored: true };
				} else body = { data: objects.get(frame.path) };
			} else {
				status = 403;
				body = { error: "cloud execution forbidden" };
			}
			child.stdin.write(`${JSON.stringify({ kind: "response", id: frame.id, status, body })}\n`);
		});
	});
	child.stdin.write(`${JSON.stringify({ kind: "init", dataRoot, token })}\n`);
	const port = await ready;
	return {
		child,
		port,
		logs: () => stderr,
		request: async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				headers: { "content-type": "application/json", "x-geo-local-token": token, ...headers },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		},
		stop: async () => {
			const exited = once(child, "exit");
			child.stdin.write('{"kind":"shutdown"}\n');
			expect((await exited)[0], stderr).toBe(0);
		},
	};
}

it("runs business locally, survives restart, syncs SQLite and restores without device credentials", async () => {
	const engine = await start(join(root, "device-one"));
	expect((await engine.request("/api/health")).body).toMatchObject({
		database: "sqlite",
		execution: "client",
		captureRunner: "client",
	});
	expect((await engine.request("/api/projects", "GET", undefined, { "x-geo-local-token": "wrong" })).status).toBe(403);
	expect((await engine.request("/api/projects", "GET", undefined, { origin: "http://malicious.test" })).status).toBe(
		403,
	);
	expect((await engine.request("/api/auth/me")).status).toBe(403);
	const project = await engine.request("/api/projects", "POST", {
		name: "SQLite integration fixture",
		region: "Test region",
		language: "en",
	});
	expect(project.status, JSON.stringify(project.body)).toBe(201);
	expect(JSON.stringify((await engine.request("/api/projects")).body)).toContain(project.body.id);
	const archiveTarget = await engine.request("/api/projects", "POST", {
		name: "Local permission transaction fixture",
		region: "Test region",
		language: "en",
	});
	const archived = await engine.request(`/api/projects/${archiveTarget.body.id}/archive`, "POST", {
		confirmName: "Local permission transaction fixture",
		confirmed: true,
	});
	expect(archived.status, JSON.stringify(archived.body)).toBe(200);
	const modelAddress = modelServer.address();
	if (!modelAddress || typeof modelAddress === "string") throw new Error("No model port");
	const provider = await engine.request("/api/settings/hrouter", "PUT", {
		apiKey: "fixture-secret-not-live",
		baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
		model: "gpt-test",
	});
	expect(provider.status, JSON.stringify(provider.body)).toBe(200);
	const session = await engine.request(`/api/projects/${project.body.id}/workbench/sessions`, "POST", {
		title: "Persistent test session",
		executionTarget: "server",
		webSearchEnabled: false,
	});
	expect(session.status, JSON.stringify(session.body)).toBe(201);
	const sent = await engine.request(`/api/workbench/sessions/${session.body.id}/messages`, "POST", {
		message: "Verify the local engine",
	});
	expect(sent.status, JSON.stringify(sent.body)).toBe(202);
	await expect
		.poll(
			async () => JSON.stringify((await engine.request(`/api/workbench/sessions/${session.body.id}/events`)).body),
			{ timeout: 15_000, interval: 100 },
		)
		.toContain("Local model integration verified");
	expect(modelRequests.length).toBeGreaterThan(0);
	const sync = await engine.request("/api/desktop-local/sync", "POST");
	expect(sync.body.syncError, engine.logs()).toBeNull();
	expect(head.revision).toBeGreaterThan(0);
	await engine.stop();
	const restarted = await start(join(root, "device-one"));
	expect((await restarted.request(`/api/workbench/sessions/${session.body.id}`)).status).toBe(200);
	expect((await restarted.request(`/api/projects/${project.body.id}`)).status).toBe(200);
	await restarted.stop();
	const restored = await start(join(root, "device-two"));
	expect((await restored.request(`/api/projects/${project.body.id}`)).status).toBe(200);
	expect((await restored.request("/api/desktop-local/status")).body.credentialsNeedSetup).toBe(true);
	expect((await restored.request("/api/health")).body.analysisConfigured).toBe(false);
	await restored.stop();
	expect(
		head.manifest?.files.every((file) => file.path === "workspace.sqlite" || file.path.startsWith("artifacts/")),
	).toBe(true);
	expect(cloudPaths.every((path) => path === "/api/auth/me" || path.startsWith("/api/desktop-storage/"))).toBe(true);
	expect(await readFile(join(root, "engine.mjs"), "utf8")).not.toContain("@electric-sql/pglite");
}, 60_000);
