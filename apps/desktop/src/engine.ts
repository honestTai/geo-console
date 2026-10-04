import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Identity } from "@geo/worker/desktop-identity";
import {
	type CloudRequest,
	readLocalRevision,
	recoverPendingCommit,
	restoreWorkspace,
	saveLocalRevision,
	syncWorkspace,
	type WorkspaceHead,
} from "./workspace-sync";

// Stdout belongs exclusively to the native broker; business logs must not corrupt its framing.
console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);
const output = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let serial = 0;
const pending = new Map<
	number,
	{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let closed = false;
const cloud: CloudRequest = <T>(path: string, method = "GET", body?: unknown) =>
	new Promise<T>((resolve, reject) => {
		if (closed) {
			reject(new Error("桌面通信已断开"));
			return;
		}
		const id = ++serial;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error("云端鉴权或同步超时"));
		}, 60_000);
		pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
		output({ kind: "cloud", id, path, method, body });
	});
type Init = { kind: "init"; dataRoot: string; token: string; browserPath?: string };
type Bootstrap = {
	user: Identity;
	policies: Record<string, unknown>[];
	permissions: Record<string, unknown>[];
	workspace: WorkspaceHead;
};

async function boot(init: Init): Promise<void> {
	const bootstrap = await cloud<Bootstrap>("/api/desktop-storage/bootstrap");
	const original = bootstrap.user;
	if (!original.id || original.localBypass || original.organizationSuspended || !original.principal.active)
		throw new Error("请使用有效云端账号登录");
	const namespace = createHash("sha256")
		.update(JSON.stringify([original.organizationId, original.id]))
		.digest("hex");
	const root = join(init.dataRoot, namespace);
	await mkdir(root, { recursive: true, mode: 0o700 });
	let head = await recoverPendingCommit(root, bootstrap.workspace, cloud);
	const revision = await readLocalRevision(root);
	const databaseExists = await stat(join(root, "workspace.sqlite"))
		.then(() => true)
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return false;
			throw error;
		});
	if (revision === null && databaseExists) throw new Error("本机工作区缺少同步版本，已保留原数据，请先修复同步元数据");
	if (revision !== null && revision !== head.revision)
		throw new Error("工作区同步冲突：云端已有其他设备的版本。本机数据已保留，未覆盖。请先导出本机工作区后解决冲突。");
	const restore = !databaseExists ? await restoreWorkspace(root, head, cloud) : undefined;
	await saveLocalRevision(root, head.revision);
	process.env.GEO_DATA_DIR = root;
	process.env.GEO_DESKTOP_LOCAL = "true";
	process.env.GEO_OBJECT_STORE = "local";
	if (init.browserPath) process.env.PLAYWRIGHT_BROWSERS_PATH = init.browserPath;
	delete process.env.DATABASE_URL;
	const keyPath = join(root, "master-key");
	let newKey = false;
	try {
		await writeFile(keyPath, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 });
		newKey = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	process.env.GEO_MASTER_KEY_FILE = keyPath;
	const { openDesktopDatabase } = await import("@geo/core/sqlite");
	const database = await openDesktopDatabase(join(root, "workspace.sqlite"), restore);
	const { installLocalLogStore } = await import("@geo/logging");
	const { ingestServiceLogs, listServiceLogs, serviceLogsCsv, pruneOrganizationLogs } = await import(
		"@geo/log-service/service"
	);
	installLocalLogStore({
		append: (logs) => ingestServiceLogs(database, { logs }),
		query: (query) => listServiceLogs(database, query),
		exportCsv: (query) => serviceLogsCsv(database, query),
		prune: (organizationId, olderThanDays) => pruneOrganizationLogs(database, organizationId, olderThanDays),
	});
	// Cloud snapshots intentionally never contain the device's master key.
	const credentialsNeedSetup = !!restore || (newKey && databaseExists);
	if (credentialsNeedSetup) await database.query("DELETE FROM encrypted_credentials");
	let identity: Identity | null = original;
	let checkedAt = Date.now();
	let checking: Promise<Identity | null> | null = null;
	const cloudIdentity = async (): Promise<Identity | null> => {
		if (Date.now() - checkedAt < 10_000) return identity;
		if (checking) return checking;
		checking = (async () => {
			try {
				const { user } = await cloud<{ user: Identity }>("/api/auth/me");
				identity =
					user.id === original.id &&
					user.organizationId === original.organizationId &&
					user.authorizationRevision === original.authorizationRevision &&
					user.principal.active &&
					!user.organizationSuspended
						? user
						: null;
			} catch {
				identity = null;
			}
			checkedAt = Date.now();
			checking = null;
			return identity;
		})();
		return checking;
	};
	const { installDesktopIdentity, scopeDesktopIdentity, HttpInputError } = await import("@geo/worker/desktop-identity");
	const currentIdentity = async () => {
		const current = await cloudIdentity();
		return current ? scopeDesktopIdentity(database, current) : null;
	};
	await installDesktopIdentity(database, original, bootstrap.policies, cloudIdentity, bootstrap.permissions);
	let syncing: Promise<void> | null = null;
	let syncError: string | null = null;
	let lastSynced: string | null = null;
	let syncedGeneration = -1;
	const sync = (): Promise<void> => {
		if (syncing) return syncing;
		if (database.generation === syncedGeneration) return Promise.resolve();
		const generation = database.generation;
		syncing = syncWorkspace(root, () => database.snapshot(), head, cloud)
			.then((next) => {
				head = next;
				syncError = null;
				syncedGeneration = generation;
				lastSynced = new Date().toISOString();
			})
			.catch((error) => {
				syncError = error instanceof Error ? error.message : "云端同步失败";
				throw error;
			})
			.finally(() => {
				syncing = null;
			});
		return syncing;
	};
	const token = Buffer.from(init.token);
	const { startApiService } = await import("@geo/worker/api-service");
	const service = await startApiService({
		database,
		host: "127.0.0.1",
		port: 0,
		local: true,
		authenticate: currentIdentity,
		guard: async (request) => {
			const value = Buffer.from(String(request.headers["x-geo-local-token"] ?? ""));
			if (value.length !== token.length || !timingSafeEqual(value, token) || request.headers.origin)
				throw new HttpInputError("本地接口拒绝未授权请求", 403);
			const path = new URL(request.url ?? "/", "http://local").pathname;
			if (
				path.startsWith("/api/auth/") ||
				path.startsWith("/api/users") ||
				path.startsWith("/api/organizations") ||
				(path.startsWith("/api/rbac/") && path !== "/api/rbac/navigation")
			)
				throw new HttpInputError("账号与授权管理只能在云端完成", 403);
		},
		extension: async (request, response) => {
			const path = new URL(request.url ?? "/", "http://local").pathname;
			if (path !== "/api/desktop-local/status" && path !== "/api/desktop-local/sync") return false;
			if (path.endsWith("/sync") && request.method === "POST") await sync();
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					execution: "client",
					storage: "sqlite",
					workspace: "account-private",
					revision: head.revision,
					syncing: !!syncing,
					syncError,
					lastSynced,
					credentialsNeedSetup,
				}),
			);
			return true;
		},
	});
	const timer = setInterval(() => void sync().catch(() => undefined), 60_000);
	const authTimer = setInterval(() => void currentIdentity(), 10_000);
	output({ kind: "ready", port: service.port });
	let stopping = false;
	shutdown = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(timer);
		clearInterval(authTimer);
		await service.close();
		await sync().catch(() => undefined);
		await database.close();
		output({ kind: "stopped", syncError });
		process.exit(0);
	};
}
let shutdown: () => Promise<void> = async () => {
	process.exit(Number(process.exitCode ?? 0));
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
lines.on("line", (line) => {
	try {
		const frame = JSON.parse(line);
		if (frame.kind === "response") {
			const item = pending.get(frame.id);
			if (!item) return;
			clearTimeout(item.timer);
			pending.delete(frame.id);
			if (frame.error || frame.status >= 400)
				item.reject(new Error(frame.error ?? frame.body?.error ?? `云端请求失败 ${frame.status}`));
			else item.resolve(frame.body);
		} else if (frame.kind === "init" && !initialized) {
			initialized = true;
			void boot(frame).catch((error) => {
				output({ kind: "fatal", error: error instanceof Error ? error.message : String(error) });
				process.exitCode = 1;
				lines.close();
				process.stdin.destroy();
			});
		} else if (frame.kind === "shutdown") void shutdown();
	} catch (error) {
		output({ kind: "fatal", error: String(error) });
	}
});
lines.on("close", () => {
	closed = true;
	for (const item of pending.values()) {
		clearTimeout(item.timer);
		item.reject(new Error("桌面通信已断开"));
	}
	pending.clear();
	void shutdown();
});
