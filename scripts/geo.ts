#!/usr/bin/env node
import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ensureMasterKey, geoPaths, migrateDatabase, openDatabase } from "@geo/core";

const command = process.argv[2] ?? "help";

async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

async function setup(): Promise<void> {
	for (const directory of Object.values(geoPaths)) await mkdir(directory, { recursive: true });
	const database = await openDatabase();
	try { await migrateDatabase(database); } finally { await database.close(); }
	await ensureMasterKey();
	const pdfCheck = spawnSync(
		"corepack",
		[
			"pnpm",
			"--filter",
			"@geo/worker",
			"exec",
			"tsx",
			"-e",
			'import { chromium } from "playwright"; import { existsSync } from "node:fs"; const configured=process.env.GEO_PLAYWRIGHT_EXECUTABLE_PATH; const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; if (![configured,chromium.executablePath(),process.platform === "darwin" ? macChrome : ""].some((path)=>path && existsSync(path))) process.exit(1)',
		],
		{ encoding: "utf8" },
	);
	console.log("GEO Console 本机目录已初始化：", geoPaths.root);
	console.log("PGlite 数据库迁移完成；本机主密钥已保存到 macOS 钥匙串。");
	console.log(
		pdfCheck.status === 0
			? "Report Worker 的 Chromium 或系统 Chrome 已就绪。"
			: "请运行：corepack pnpm --filter @geo/worker exec playwright install chromium",
	);
	console.log("在网页“平台设置”中配置五个平台和 HRouter 密钥后即可运行真实云端链路。");
}

async function waitForWorker(): Promise<void> {
	for (let index = 0; index < 40; index += 1) {
		try { if ((await fetch("http://127.0.0.1:3010/api/health")).ok) return; } catch { /* keep waiting */ }
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Worker 在 10 秒内没有启动成功");
}

async function start(): Promise<void> {
	await setup();
	const processes: ChildProcess[] = [];
	const launch = (filter: string, script: string) => {
		const child = spawn("corepack", ["pnpm", "--filter", filter, script], { stdio: "inherit", env: process.env });
		processes.push(child);
		child.on("exit", (code) => { if (code && code !== 0) console.error(`${filter} 已退出，状态码 ${code}`); });
		return child;
	};
	launch("@geo/worker", "start");
	await waitForWorker();
	launch("@geo/worker", "start:capture");
	launch("@geo/worker", "start:agent");
	launch("@geo/worker", "start:report");
	launch("@geo/web", "dev");
	console.log("\nGEO Console 工作台: http://127.0.0.1:3000/app/\n");
	const stop = () => { for (const child of processes) child.kill("SIGTERM"); };
	process.on("SIGINT", stop); process.on("SIGTERM", stop);
	await new Promise<void>((resolve) => {
		let remaining = processes.length;
		for (const child of processes) child.on("exit", () => { remaining -= 1; if (remaining === 0) resolve(); });
	});
}

async function doctor(): Promise<void> {
	console.log(`Node: ${process.version}`);
	console.log(`数据目录: ${geoPaths.root} (${await exists(geoPaths.root) ? "存在" : "未初始化"})`);
	try { const health = await fetch("http://127.0.0.1:3010/api/health"); console.log(`Worker: ${health.ok ? "正常" : `HTTP ${health.status}`}`); } catch { console.log("Worker: 未运行"); }
}

async function backup(): Promise<void> {
	try { if ((await fetch("http://127.0.0.1:3010/api/health")).ok) throw new Error("请先停止本机服务再备份，避免复制运行中的 PGlite 文件"); } catch (error) {
		if (error instanceof Error && error.message.startsWith("请先停止")) throw error;
	}
	const destination = join(geoPaths.backups, new Date().toISOString().replace(/[:.]/g, "-"));
	await mkdir(destination, { recursive: true });
	if (await exists(geoPaths.database)) await cp(geoPaths.database, join(destination, "database"), { recursive: true, errorOnExist: true });
	if (await exists(geoPaths.artifacts)) await cp(geoPaths.artifacts, join(destination, "artifacts"), { recursive: true, errorOnExist: true });
	console.log("备份完成：", destination);
}

async function main(): Promise<void> {
	if (command === "setup") return setup();
	if (command === "start") return start();
	if (command === "doctor") return doctor();
	if (command === "backup") return backup();
	console.log("用法：pnpm geo <setup|start|doctor|backup>");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
