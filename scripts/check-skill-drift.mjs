#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const usage = [
	"Usage:",
	"  corepack pnpm check-drift -- --major [--base REF]",
	"  corepack pnpm check-drift -- --major --file PATH [--file PATH ...]",
	"",
	"Use --base with the pre-task Git ref. In a shared dirty worktree, pass every",
	"task-owned changed file explicitly with repeated --file arguments.",
].join("\n");

function fail(message) {
	console.error("[check-drift] " + message);
	process.exitCode = 1;
}

function normalizePath(value) {
	return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function gitLines(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8" }).split(/\r?\n/).map(normalizePath).filter(Boolean);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error("Git inspection failed: " + detail);
	}
}

const args = process.argv.slice(2);
let base = "HEAD";
let major = false;
const explicitFiles = [];

for (let index = 0; index < args.length; index += 1) {
	const argument = args[index];
	if (argument === "--") continue;
	if (argument === "--major") {
		major = true;
		continue;
	}
	if (argument === "--base") {
		base = args[index + 1] ?? "";
		index += 1;
		if (!base) {
			fail("--base requires a Git ref");
			console.error(usage);
			process.exit();
		}
		continue;
	}
	if (argument === "--file") {
		const file = args[index + 1] ?? "";
		index += 1;
		if (!file) {
			fail("--file requires a repository-relative path");
			console.error(usage);
			process.exit();
		}
		explicitFiles.push(normalizePath(file));
		continue;
	}
	if (argument === "--help" || argument === "-h") {
		console.log(usage);
		process.exit();
	}
	fail("unknown argument: " + argument);
	console.error(usage);
	process.exit();
}

if (!major) {
	fail("--major is required; use it only after the change meets the documented major-change criteria");
	console.error(usage);
	process.exit();
}

let changedFiles;
try {
	changedFiles =
		explicitFiles.length > 0
			? [...new Set(explicitFiles)]
			: [
					...new Set([
						...gitLines(["diff", "--name-only", "--diff-filter=ACMRTUXB", base, "--"]),
						...gitLines(["ls-files", "--others", "--exclude-standard"]),
					]),
				];
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
	process.exit();
}

if (changedFiles.length === 0) {
	fail("no changed files were found");
	process.exit();
}

const matchesAny = (patterns, file) => patterns.some((pattern) => pattern.test(file));
const changed = new Set(changedFiles);

const categories = [
	{
		id: "architecture",
		patterns: [
			/^apps\/.*\/(?:src\/.*\.(?:ts|tsx)|package\.json)$/,
			/^packages\/.*\/(?:src\/.*\.ts|package\.json)$/,
			/^(?:package\.json|pnpm-workspace\.yaml|turbo\.json)$/,
			/^(?:compose\.yaml|docker\/|deploy\/|scripts\/geo\.ts)/,
		],
		requiredAll: ["docs/architecture.md", ".agents/skills/geo-development/references/project-map.md"],
	},
	{
		id: "domain",
		patterns: [
			/^packages\/core\/(?:src\/schema\.ts|migrations\/)/,
			/^packages\/authorization\/src\//,
			/^apps\/worker\/src\/authorization\//,
			/^packages\/(?:evidence|metrics)\/src\//,
			/^apps\/worker\/src\/(?:service|cloud-runner|agent|agent-jobs|report|report-snapshots|crawler|auth|attribution|providers)\.ts$/,
		],
		requiredAll: [".agents/skills/geo-development/references/domain-contracts.md"],
	},
	{
		id: "provider",
		patterns: [/^packages\/search-providers\/src\//, /^apps\/worker\/src\/(?:providers|cloud-runner)\.ts$/],
		requiredAll: ["docs/search-provider-adapters.md", ".agents/skills/geo-development/references/domain-contracts.md"],
	},
	{
		id: "operations",
		patterns: [
			/^packages\/core\/src\/repository\.ts$/,
			/^packages\/search-providers\/src\//,
			/^apps\/worker\/src\/(?:capture-worker|agent-worker|report-worker|cloud-runner|agent-jobs|report-snapshots|service|object-store|providers)\.ts$/,
			/^compose\.yaml$/,
		],
		requiredAll: ["docs/operations.md", ".agents/skills/geo-operations/references/runtime-runbook.md"],
	},
	{
		id: "deployment",
		patterns: [
			/^(?:compose\.yaml|\.env\.example)$/,
			/^(?:docker|deploy)\//,
			/^scripts\/geo\.ts$/,
			/^packages\/core\/src\/(?:database|paths|secrets)\.ts$/,
		],
		requiredAll: ["docs/deployment.md"],
		requiredAny: [
			".agents/skills/geo-deployment/SKILL.md",
			".agents/skills/geo-deployment/references/preflight.md",
			".agents/skills/geo-deployment/references/release-workflow.md",
		],
	},
	{
		id: "capability",
		patterns: [
			/^apps\/web\/src\/App\.tsx$/,
			/^apps\/worker\/src\/(?:index|service|agent|report|report-snapshots|crawler|attribution)\.ts$/,
		],
		requiredAll: ["docs/capability-matrix.md", ".agents/skills/geo-development/references/project-map.md"],
	},
];

const triggered = categories.filter((category) => changedFiles.some((file) => matchesAny(category.patterns, file)));
if (triggered.length === 0) {
	fail("the supplied files do not match a major-change impact category; review the file list and classification");
	process.exit();
}

const missing = [];
for (const category of triggered) {
	for (const required of category.requiredAll ?? []) {
		if (!changed.has(required)) missing.push(category.id + ": " + required);
	}
	if (category.requiredAny && !category.requiredAny.some((required) => changed.has(required))) {
		missing.push(category.id + ": one of [" + category.requiredAny.join(", ") + "]");
	}
}

console.log("[check-drift] changed files: " + changedFiles.length);
console.log("[check-drift] impact categories: " + triggered.map((category) => category.id).join(", "));

if (missing.length > 0) {
	fail("knowledge synchronization is incomplete:");
	for (const item of missing) console.error("  - " + item);
	process.exit();
}

console.log("[check-drift] required docs and skill references are present in the change set.");
