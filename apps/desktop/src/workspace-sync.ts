import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type WorkspaceManifest, workspaceManifestSchema } from "@geo/core/desktop-workspace";

export type CloudRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type WorkspaceHead = { revision: number; manifest: WorkspaceManifest | null };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function readLocalRevision(root: string): Promise<number | null> {
	try {
		const value = (JSON.parse(await readFile(join(root, "sync.json"), "utf8")) as { revision: number }).revision;
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("工作区同步版本无效");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Complete the same CAS after a lost response; never silently accept another device's write. */
export async function recoverPendingCommit(
	root: string,
	head: WorkspaceHead,
	cloud: CloudRequest,
): Promise<WorkspaceHead> {
	const file = join(root, "sync-pending.json");
	const pending = await readFile(file, "utf8")
		.then((text) => JSON.parse(text) as { baseRevision: number; manifest: WorkspaceManifest })
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	if (!pending) return head;
	const manifest = workspaceManifestSchema.parse(pending.manifest);
	const result = await cloud<{ revision: number }>("/api/desktop-storage/commit", "POST", {
		baseRevision: pending.baseRevision,
		manifest,
	});
	await saveLocalRevision(root, result.revision);
	await rm(file, { force: true });
	return { revision: result.revision, manifest };
}
export async function saveLocalRevision(root: string, revision: number): Promise<void> {
	await writeFile(join(root, "sync.json.tmp"), JSON.stringify({ revision }), { mode: 0o600 });
	await rename(join(root, "sync.json.tmp"), join(root, "sync.json"));
}

async function writeRestoredArtifact(destination: string, bytes: Buffer): Promise<void> {
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	try {
		await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readFile(destination)) !== hash(bytes))
			throw error;
	}
}

/** Restore only into a fresh account directory. Never unpack paths supplied by an archive. */
export async function restoreWorkspace(
	root: string,
	head: WorkspaceHead,
	cloud: CloudRequest,
): Promise<Blob | undefined> {
	if (!head.manifest) return undefined;
	const manifest = workspaceManifestSchema.parse(head.manifest);
	let database: Blob | undefined;
	for (const file of manifest.files) {
		const parts: Buffer[] = [];
		for (const digest of file.chunks) {
			const response = await cloud<{ data: string }>(`/api/desktop-storage/objects/${digest}`);
			const bytes = Buffer.from(response.data, "base64");
			if (bytes.length > 1_048_576 || hash(bytes) !== digest) throw new Error("云端工作区对象校验失败，本机数据未覆盖");
			parts.push(bytes);
		}
		const bytes = Buffer.concat(parts);
		if (bytes.length !== file.size) throw new Error("工作区文件大小不匹配");
		if (file.path === "workspace.sqlite") database = new Blob([new Uint8Array(bytes)]);
		else await writeRestoredArtifact(join(root, file.path), bytes);
	}
	return database;
}

async function artifactPaths(root: string, relative = "artifacts"): Promise<string[]> {
	const entries = await readdir(join(root, relative), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error("工作区不允许同步符号链接");
		const path = `${relative}/${entry.name}`;
		if (entry.isDirectory()) paths.push(...(await artifactPaths(root, path)));
		else if (entry.isFile()) paths.push(path);
	}
	return paths;
}

export async function syncWorkspace(
	root: string,
	snapshot: () => Promise<Blob>,
	head: WorkspaceHead,
	cloud: CloudRequest,
): Promise<WorkspaceHead> {
	head = await recoverPendingCommit(root, head, cloud);
	const files: WorkspaceManifest["files"] = [];
	const known = new Set(head.manifest?.files.flatMap((file) => file.chunks) ?? []);
	const database = Buffer.from(await (await snapshot()).arrayBuffer());
	for (const path of ["workspace.sqlite", ...(await artifactPaths(root))]) {
		const bytes = path === "workspace.sqlite" ? database : await readFile(join(root, path));
		const chunks: string[] = [];
		for (let offset = 0; offset < bytes.length; offset += 1_048_576) {
			const chunk = bytes.subarray(offset, offset + 1_048_576);
			const digest = hash(chunk);
			if (!known.has(digest)) {
				await cloud(`/api/desktop-storage/objects/${digest}`, "PUT", { data: chunk.toString("base64") });
				known.add(digest);
			}
			chunks.push(digest);
		}
		files.push({ path, size: bytes.length, chunks });
	}
	const manifest = workspaceManifestSchema.parse({ format: "geo.desktop-workspace.sqlite.v1", files });
	await writeFile(join(root, "sync-pending.json.tmp"), JSON.stringify({ baseRevision: head.revision, manifest }), {
		mode: 0o600,
	});
	await rename(join(root, "sync-pending.json.tmp"), join(root, "sync-pending.json"));
	const result = await cloud<{ revision: number }>("/api/desktop-storage/commit", "POST", {
		baseRevision: head.revision,
		manifest,
	});
	await saveLocalRevision(root, result.revision);
	await rm(join(root, "sync-pending.json"), { force: true });
	return { revision: result.revision, manifest };
}
