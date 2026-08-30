import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const serviceName = "com.geoconsole.local";

export type SecretKey = "deepseek_api_key" | "admin_password";

const envNames: Record<SecretKey, string> = {
	deepseek_api_key: "DEEPSEEK_API_KEY",
	admin_password: "GEO_ADMIN_PASSWORD",
};

export async function readSecret(key: SecretKey): Promise<string | null> {
	const fromEnvironment = process.env[envNames[key]]?.trim();
	if (fromEnvironment) return fromEnvironment;
	const filePath = process.env[`${envNames[key]}_FILE`]?.trim();
	if (filePath) return (await readFile(filePath, "utf8")).trim() || null;
	if (process.platform !== "darwin") return null;
	try {
		const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", serviceName, "-a", key, "-w"]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function writeSecret(key: SecretKey, value: string): Promise<void> {
	if (process.platform !== "darwin") {
		throw new Error(`当前系统请通过 ${envNames[key]} 配置密钥`);
	}
	await execFileAsync("security", ["add-generic-password", "-U", "-s", serviceName, "-a", key, "-w", value]);
}
