import { tmpdir } from "node:os";
import { join } from "node:path";
import { geoPaths, readSecret } from "@geo/core";
import { describe, expect, it } from "vitest";

describe("隔离测试环境", () => {
	it("使用独立临时目录和随机测试主密钥，不连接已有数据库或对象存储", () => {
		expect(geoPaths.root.startsWith(join(tmpdir(), "geo-worker-test-"))).toBe(true);
		expect(geoPaths.root).toBe(process.env.GEO_DATA_DIR);
		expect(Buffer.from(process.env.GEO_MASTER_KEY ?? "", "base64")).toHaveLength(32);
		expect(process.env.DATABASE_URL).toBeUndefined();
		expect(process.env.GEO_OBJECT_STORE).toBe("local");
	});

	it("缺少测试凭据时返回 null，不回退到真实密钥文件或系统钥匙串", async () => {
		expect(process.env.HROUTER_API_KEY_FILE).toBe(join(geoPaths.root, "empty-test-secret"));
		expect(await readSecret("hrouter_api_key")).toBeNull();
		expect(await readSecret("deepseek_api_key")).toBeNull();
		expect(await readSecret("admin_password")).toBeNull();
	});
});
