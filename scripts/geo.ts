#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { geoPaths, migrateDatabase, openDatabase, writeSecret } from "@geo/core";

const command = process.argv[2] ?? "help";

async function exists(path: string): Promise<boolean> {
	try { await stat(path); return true; } catch { return false; }
}

async function ensureCollectorConfig(): Promise<{ nodeId: string; token: string }> {
	const configPath = join(geoPaths.root, "collector.json");
	if (await exists(configPath)) return JSON.parse(await readFile(configPath, "utf8")) as { nodeId: string; token: string };
	const database = await openDatabase();
	try {
		await migrateDatabase(database);
		const nodeId = randomUUID();
		const token = randomBytes(32).toString("base64url");
		const tokenHash = createHash("sha256").update(token).digest("hex");
		await database.query("INSERT INTO collector_nodes (id,name,token_hash,version,capabilities) VALUES ($1,'本机采集器',$2,'0.1.0',$3::jsonb)", [nodeId, tokenHash, JSON.stringify(["deepseek", "kimi"])]);
		await writeFile(configPath, `${JSON.stringify({ nodeId, token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		return { nodeId, token };
	} finally { await database.close(); }
}

async function setup(): Promise<void> {
	for (const directory of Object.values(geoPaths)) await mkdir(directory, { recursive: true });
	const database = await openDatabase();
	try { await migrateDatabase(database); } finally { await database.close(); }
	const collector = await ensureCollectorConfig();
	const browserCheck = spawnSync("corepack", ["pnpm", "--filter", "@geo/collector", "exec", "tsx", "-e", 'import { chromium } from "playwright"; import { accessSync, existsSync } from "node:fs"; const system="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; const configured=process.env.GEO_CHROME_PATH; const path=configured||(existsSync(chromium.executablePath())?chromium.executablePath():system); accessSync(path)'], { encoding: "utf8" });
	const envKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (envKey && process.platform === "darwin") await writeSecret("deepseek_api_key", envKey);
	console.log("GEO Console 本机目录已初始化：", geoPaths.root);
	console.log("PGlite 数据库迁移完成；Collector 节点：", collector.nodeId);
	console.log(envKey ? "DeepSeek API Key 已写入 macOS 钥匙串。" : "DeepSeek API Key 尚未写入，可在网页“平台设置”中保存。");
	console.log(browserCheck.status === 0 ? "Chrome/Chromium 已就绪。" : "未找到 Chrome/Chromium；请设置 GEO_CHROME_PATH，或运行：pnpm --filter @geo/collector exec playwright install chromium");
	console.log("浏览器首次运行时请分别打开 DeepSeek 与 Kimi 登录页并手工登录。");
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
	launch("@geo/collector", "start");
	launch("@geo/web", "dev");
	console.log("\nGEO Console: http://127.0.0.1:3000\n");
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
	console.log(`Collector 配对: ${await exists(join(geoPaths.root, "collector.json")) ? "已配置" : "未配置"}`);
	try { const health = await fetch("http://127.0.0.1:3010/api/health"); console.log(`Worker: ${health.ok ? "正常" : `HTTP ${health.status}`}`); } catch { console.log("Worker: 未运行"); }
	try { const status = await fetch("http://127.0.0.1:3020/status"); console.log(`Collector: ${status.ok ? "正常" : `HTTP ${status.status}`}`); } catch { console.log("Collector: 未运行"); }
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
