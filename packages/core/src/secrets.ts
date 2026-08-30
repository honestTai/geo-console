import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Database } from "./database";

const execFileAsync = promisify(execFile);
const serviceName = "com.geoconsole.local";

export type SecretKey =
	| "deepseek_api_key"
	| "kimi_api_key"
	| "doubao_api_key"
	| "qwen_api_key"
	| "yuanbao_api_key"
	| "hunyuan_api_key"
	| "hrouter_api_key"
	| "geo_master_key"
	| "admin_password";

const envNames: Record<SecretKey, string> = {
	deepseek_api_key: "DEEPSEEK_API_KEY",
	kimi_api_key: "KIMI_API_KEY",
	doubao_api_key: "DOUBAO_API_KEY",
	qwen_api_key: "DASHSCOPE_API_KEY",
	yuanbao_api_key: "TENCENTCLOUD_WSA_APIKEY",
	hunyuan_api_key: "HUNYUAN_API_KEY",
	hrouter_api_key: "HROUTER_API_KEY",
	geo_master_key: "GEO_MASTER_KEY",
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

function decodeMasterKey(value: string): Buffer {
	const decoded = Buffer.from(value, "base64");
	if (decoded.length !== 32) throw new Error("GEO_MASTER_KEY 必须是 32 字节随机值的 Base64 编码");
	return decoded;
}

export async function ensureMasterKey(): Promise<string> {
	const existing = await readSecret("geo_master_key");
	if (existing) return existing;
	if (process.platform !== "darwin") throw new Error("服务器必须通过 GEO_MASTER_KEY 或 GEO_MASTER_KEY_FILE 提供主密钥");
	const generated = randomBytes(32).toString("base64");
	await writeSecret("geo_master_key", generated);
	return generated;
}

export async function writeEncryptedCredential(
	database: Database,
	credentialKey: SecretKey,
	value: string,
	organizationId = "default",
): Promise<void> {
	const masterKey = decodeMasterKey(await ensureMasterKey());
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
	cipher.setAAD(Buffer.from(`${organizationId}:${credentialKey}`));
	const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	await database.query(
		`INSERT INTO encrypted_credentials
		 (id,organization_id,credential_key,ciphertext,iv,auth_tag,key_version,created_at,updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
		 ON CONFLICT (organization_id,credential_key) DO UPDATE SET
		 ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,
		 key_version=excluded.key_version,updated_at=now()`,
		[
			randomUUID(),
			organizationId,
			credentialKey,
			ciphertext.toString("base64"),
			iv.toString("base64"),
			authTag.toString("base64"),
			process.env.GEO_MASTER_KEY_VERSION?.trim() || "local-v1",
		],
	);
}

export async function readEncryptedCredential(
	database: Database,
	credentialKey: SecretKey,
	organizationId = "default",
): Promise<string | null> {
	const row = (
		await database.query<{ ciphertext: string; iv: string; auth_tag: string }>(
			"SELECT ciphertext,iv,auth_tag FROM encrypted_credentials WHERE organization_id=$1 AND credential_key=$2",
			[organizationId, credentialKey],
		)
	).rows[0];
	if (!row) return readSecret(credentialKey);
	const master = await readSecret("geo_master_key");
	if (!master) throw new Error("已存在加密凭据，但 GEO_MASTER_KEY 不可用");
	const decipher = createDecipheriv("aes-256-gcm", decodeMasterKey(master), Buffer.from(row.iv, "base64"));
	decipher.setAAD(Buffer.from(`${organizationId}:${credentialKey}`));
	decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
