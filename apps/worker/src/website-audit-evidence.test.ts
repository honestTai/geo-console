import { createHash } from "node:crypto";
import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveArtifact } from "./authorization/resources";
import { auditWebsite } from "./crawler";
import { readArtifact } from "./object-store";
import { getWebsiteEvidence } from "./website-evidence";
import { renderWebsiteAuditHtml } from "./website-report";

const control = vi.hoisted(() => ({ blocked: false, screenshotFails: false }));
vi.mock("./public-http", () => ({
	PublicHttpError: class extends Error {},
	assertPublicUrl: async (value: string) => new URL(value),
	fetchPublicText: async (url: URL) => {
		if (control.blocked) throw new Error("Network unavailable");
		const bodies: Record<string, string> = {
			"/":
				'<html lang="en"><head><title>测试品牌</title><meta name="description" content="测试客户"></head><body><nav><a href="/about">关于我们</a></nav><h2>真实测试内容</h2>' +
				"测试正文".repeat(30) +
				"</body></html>",
			"/robots.txt": "User-agent: *\nAllow: /\nSitemap: /actual-map.xml",
			"/actual-map.xml": "<urlset><url><loc>https://example.com/about</loc></url></urlset>",
		};
		if (!bodies[url.pathname]) throw new Error(`${url.href} 返回 HTTP 404`);
		return {
			body: bodies[url.pathname],
			contentType: url.pathname === "/" ? "text/html" : "text/plain",
			finalUrl: url.href,
			status: 200,
		};
	},
}));
vi.mock("./website-screenshot", () => ({
	launchEvidenceBrowser: vi.fn(),
	websiteScreenshot: async () => {
		if (control.screenshotFails) throw new Error("missing chromium");
		return Buffer.from("test-only-png");
	},
}));
vi.mock("./website-report", async (importOriginal) => ({
	...(await importOriginal<typeof import("./website-report")>()),
	websiteAuditPdf: async () => Buffer.from("test-only-pdf"),
}));

beforeEach(() => {
	control.blocked = false;
	control.screenshotFails = false;
});
describe("append-only website audit evidence", () => {
	it("stores original sources, screenshot, every check reference and branded report with frozen customer info", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query(
				"INSERT INTO projects(id,name,website_url,domain,region,language) VALUES('p','测试客户','https://example.com','example.com','测试地区','zh-CN')",
			);
			const first = await auditWebsite(db, "p", "https://example.com", ["测试客户"]);
			expect(first.result).toMatchObject({
				schemaVersion: "geo.website-audit.v2",
				customer: { name: "测试客户" },
				verdict: "ready_with_warnings",
				homepage: { hasBrandMention: true },
				discovery: { sitemap: { urlCount: 1 } },
			});
			expect(first.result.checks.find((c) => c.id === "A9")?.status).toBe("warning");
			for (const check of first.result.checks) {
				expect(check.selector).toBeTruthy();
				expect(check.evidenceIds?.length).toBeGreaterThan(0);
				for (const id of check.evidenceIds ?? [])
					expect(first.result.evidence?.some((item) => item.id === id)).toBe(true);
			}
			for (const item of first.result.evidence ?? [])
				if (item.objectKey) {
					const asset = await readArtifact(item.objectKey);
					expect(createHash("sha256").update(asset.body).digest("hex")).toBe(item.contentHash);
					expect(await resolveArtifact(db, item.objectKey)).toMatchObject({
						projectId: "p",
						organizationId: "default",
						kind: "website",
					});
				}
			const html = renderWebsiteAuditHtml(first.result);
			for (const text of ["ZZGEO", "zz-watermark", "测试客户", "处理建议", "原始证据索引", "actual-map.xml"])
				expect(html).toContain(text);
			const original = (await db.query("SELECT result_hash,result FROM website_audits WHERE id=$1", [first.id]))
				.rows[0];
			expect(await getWebsiteEvidence(db, "p", first.id)).toMatchObject({ kind: "audit", audit: { id: first.id } });
			await expect(getWebsiteEvidence(db, "another-project", first.id)).rejects.toThrow("该客户下没有");
			await db.query("UPDATE projects SET name='修改后的客户' WHERE id='p'");
			control.screenshotFails = true;
			const second = await auditWebsite(db, "p", "https://example.com", ["测试客户"]);
			expect(second.id).not.toBe(first.id);
			expect(second.result.evidence?.find((item) => item.kind === "screenshot")).toMatchObject({
				objectKey: null,
				error: expect.stringContaining("截图生成失败"),
			});
			expect((await db.query("SELECT result_hash,result FROM website_audits WHERE id=$1", [first.id])).rows[0]).toEqual(
				original,
			);
			expect(await resolveArtifact(db, "website-audits/p/forged.png")).toBeNull();
		} finally {
			await db.close();
		}
	}, 20_000);
	it("unreachable homepage is unverified, not evidence of missing tags or a fabricated zero score", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query("INSERT INTO projects(id,name,region,language) VALUES('p','测试客户','测试地区','zh-CN')");
			control.blocked = true;
			const audit = await auditWebsite(db, "p", "https://example.com", ["测试客户"]);
			expect(audit.result.score).toBeNull();
			expect(audit.result.verdict).toBe("blocked");
			expect(audit.result.checks.filter((c) => Number(c.id.slice(1)) >= 5).every((c) => c.status === "skip")).toBe(
				true,
			);
		} finally {
			await db.close();
		}
	}, 20_000);
});
