import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	type CloudRequest,
	readLocalRevision,
	recoverPendingCommit,
	restoreWorkspace,
	syncWorkspace,
	type WorkspaceHead,
} from "./workspace-sync";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "geo-sync-test-"));
	roots.push(root);
	return root;
}

it("syncs only SQLite/artifacts and recovers a lost commit response without a false conflict", async () => {
	const root = await directory();
	await mkdir(join(root, "artifacts"));
	await writeFile(join(root, "artifacts", "evidence.json"), '{"realTestEvidence":true}');
	await writeFile(join(root, "master-key"), "must-not-sync");
	let head: WorkspaceHead = { revision: 0, manifest: null };
	let loseResponse = true;
	const objects = new Map<string, string>();
	const cloud: CloudRequest = async <T>(path: string, method = "GET", input?: unknown) => {
		const body = input as { data: string; baseRevision: number; manifest: WorkspaceHead["manifest"] };
		let result: unknown;
		if (path.endsWith("/commit")) {
			if (body.baseRevision === head.revision) head = { revision: head.revision + 1, manifest: body.manifest };
			else if (
				body.baseRevision + 1 !== head.revision ||
				JSON.stringify(body.manifest) !== JSON.stringify(head.manifest)
			)
				throw new Error("conflict");
			if (loseResponse) {
				loseResponse = false;
				throw new Error("lost response");
			}
			result = { revision: head.revision };
		} else if (method === "PUT") {
			objects.set(path, body.data);
			result = { stored: true };
		} else result = { data: objects.get(path) };
		return result as T;
	};
	const snapshot = async () => new Blob(["SQLite-test-snapshot"]);
	await expect(syncWorkspace(root, snapshot, head, cloud)).rejects.toThrow("lost response");
	const recovered = await recoverPendingCommit(root, head, cloud);
	expect(recovered.revision).toBe(1);
	expect(await readLocalRevision(root)).toBe(1);
	const destination = await directory();
	const restored = await restoreWorkspace(destination, recovered, cloud);
	expect(await restored?.text()).toBe("SQLite-test-snapshot");
	expect(await readFile(join(destination, "artifacts/evidence.json"), "utf8")).toContain("realTestEvidence");
	await expect(restoreWorkspace(destination, recovered, cloud)).resolves.toBeInstanceOf(Blob);
	expect(recovered.manifest?.files.map((file) => file.path)).toEqual(["workspace.sqlite", "artifacts/evidence.json"]);
	for (const [path, data] of objects)
		expect(path.endsWith(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"))).toBe(true);
});
