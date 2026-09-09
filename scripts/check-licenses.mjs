#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const allowed = new Set([
	"MIT",
	"MIT-0",
	"MIT License",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"CC0-1.0",
	"Unlicense",
	"MPL-2.0",
	"(MIT OR Apache-2.0)",
	"MIT OR Apache-2.0",
	"Apache-2.0 OR MIT",
	"(MIT OR CC0-1.0)",
	"(MIT AND Zlib)",
	"MIT AND ISC",
	"(Apache-2.0 AND MIT)",
	"(AFL-2.1 OR BSD-3-Clause)",
	"(BSD-3-Clause OR GPL-2.0)",
	"(MPL-2.0 OR Apache-2.0)",
	"(MIT OR WTFPL)",
	"(BSD-2-Clause OR MIT OR Apache-2.0)",
]);

const exceptions = new Map([
	["caniuse-lite", "CC-BY-4.0"],
	["argparse", "Python-2.0"],
]);

// Windows command shims require cmd.exe; the command text is fixed, with no user input.
const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "corepack";
const args = process.platform === "win32"
	? ["/d", "/s", "/c", "corepack.cmd pnpm licenses list --json"]
	: ["pnpm", "licenses", "list", "--json"];
const raw = execFileSync(command, args, {
	encoding: "utf8",
	maxBuffer: 50 * 1024 * 1024,
});
const licenses = JSON.parse(raw);
const violations = [];
let total = 0;

for (const [license, packages] of Object.entries(licenses)) {
	for (const dependency of packages) {
		total += 1;
		if (allowed.has(license) || exceptions.get(dependency.name) === license) continue;
		violations.push(`${dependency.name}@${dependency.versions.join(",")} (${license})`);
	}
}

if (violations.length) {
	console.error(`发现 ${violations.length} 个未审核许可证：\n${violations.join("\n")}`);
	process.exit(1);
}

console.log(`许可证检查通过：${total} 个依赖包。`);
