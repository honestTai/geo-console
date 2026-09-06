import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Run before application imports: geoPaths is frozen when @geo/core is first loaded.
const dataDir = mkdtempSync(join(tmpdir(), "geo-worker-test-"));
const emptySecret = join(dataDir, "empty-test-secret");
writeFileSync(emptySecret, "", { mode: 0o600 });
process.env.GEO_DATA_DIR = dataDir;
process.env.GEO_MASTER_KEY = randomBytes(32).toString("base64");
process.env.GEO_OBJECT_STORE = "local";
delete process.env.DATABASE_URL;
delete process.env.GEO_LOG_SERVICE_URL;
delete process.env.GEO_LOG_SERVICE_TOKEN;
delete process.env.GEO_LOG_SERVICE_TOKEN_FILE;

// An explicit empty file returns null without falling through to the user's macOS Keychain.
for (const key of [
	"DEEPSEEK_API_KEY",
	"KIMI_API_KEY",
	"DOUBAO_API_KEY",
	"DASHSCOPE_API_KEY",
	"TENCENTCLOUD_WSA_APIKEY",
	"HUNYUAN_API_KEY",
	"HROUTER_API_KEY",
	"GEO_ADMIN_PASSWORD",
]) {
	delete process.env[key];
	process.env[`${key}_FILE`] = emptySecret;
}

afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
});
