import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.versions.node.startsWith("24."))
	throw new Error("Desktop runtime must be built with the project's Node.js 24 runtime");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!host || target !== host)
	throw new Error("Build desktop runtime natively on each target OS/architecture; cross-copying Node is not supported");
const runtime = path.join(root, "src-tauri/runtime");
const binaries = path.join(root, "src-tauri/binaries");
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await mkdir(binaries, { recursive: true });
const binary = path.join(binaries, `geo-node-${target}${process.platform === "win32" ? ".exe" : ""}`);
await copyFile(process.execPath, binary);
if (process.platform !== "win32") await chmod(binary, 0o755);
const bundle = path.join(runtime, "engine.mjs");
const nodeLicenseCandidates = [
	path.resolve(path.dirname(process.execPath), "../LICENSE"),
	path.join(path.dirname(process.execPath), "LICENSE"),
];
let nodeLicense;
for (const candidate of nodeLicenseCandidates) {
	try {
		nodeLicense = await readFile(candidate, "utf8");
		if (nodeLicense.includes("Node.js")) break;
	} catch {
		/* Try the platform's other official layout. */
	}
}
if (!nodeLicense?.includes("Node.js"))
	throw new Error(
		"Cannot locate the official Node.js LICENSE alongside the runtime; use an official Node distribution",
	);
await writeFile(path.join(runtime, "NODE-LICENSE.txt"), nodeLicense);
const workspace = path.resolve(root, "../..");
const require = createRequire(path.join(workspace, "apps/worker/package.json"));
for (const name of ["playwright", "playwright-core"]) {
	const resolver =
		name === "playwright-core" ? createRequire(await realpath(require.resolve("playwright/package.json"))) : require;
	const source = path.dirname(await realpath(resolver.resolve(`${name}/package.json`)));
	await cp(source, path.join(runtime, "node_modules", name), {
		recursive: true,
		verbatimSymlinks: true,
		filter: (entry) => entry === source || !path.relative(source, entry).split(path.sep).includes("node_modules"),
	});
}
const { chromium } = require("playwright");
let browserRoot = path.dirname(chromium.executablePath());
while (!/^chromium-\d+$/.test(path.basename(browserRoot)) && path.dirname(browserRoot) !== browserRoot)
	browserRoot = path.dirname(browserRoot);
const revision = path.basename(browserRoot).match(/^chromium-(\d+)$/)?.[1];
if (!revision)
	throw new Error(
		"Cannot resolve Chromium. Run corepack pnpm --filter @geo/worker exec playwright install chromium first.",
	);
for (const directory of [`chromium-${revision}`, `chromium_headless_shell-${revision}`]) {
	const source = path.join(path.dirname(browserRoot), directory);
	await stat(source).catch(() => {
		throw new Error(`Missing ${directory}; run corepack pnpm --filter @geo/worker exec playwright install chromium`);
	});
	await cp(source, path.join(runtime, "browsers", directory), { recursive: true, verbatimSymlinks: true });
}
await build({
	entryPoints: [path.join(root, "src/engine.ts")],
	outfile: bundle,
	bundle: true,
	platform: "node",
	target: "node24",
	format: "esm",
	sourcemap: false,
	legalComments: "eof",
	logLevel: "warning",
	external: ["playwright", "playwright-core"],
	banner: {
		js: 'import {createRequire as __geoCreateRequire} from "node:module"; const require=__geoCreateRequire(import.meta.url);',
	},
	plugins: [
		{
			name: "sqlite-only-core",
			setup(build) {
				build.onResolve({ filter: /^@geo\/core$/ }, () => ({
					path: path.join(workspace, "packages/core/src/desktop-index.ts"),
				}));
				build.onResolve({ filter: /^(?:pg|@electric-sql\/pglite)(?:\/|$)/ }, (args) => {
					throw new Error(`Forbidden desktop dependency: ${args.path}`);
				});
			},
		},
	],
});
const sha256 = async (file) =>
	createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
await writeFile(
	path.join(runtime, "manifest.json"),
	`${JSON.stringify({ engine: "deepagents-langgraph", database: "sqlite", schema: 1, chromiumRevision: revision, node: process.versions.node, target, runtimeSha256: await sha256(bundle), nodeSha256: await sha256(binary) }, null, 2)}\n`,
);
console.log(
	`Prepared complete local business engine for ${target} (Node ${process.versions.node}, SQLite, Chromium ${revision})`,
);
