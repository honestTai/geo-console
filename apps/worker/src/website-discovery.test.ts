import { describe, expect, it } from "vitest";
import { discoverSitemaps, parseSitemap, type WebsiteProbe } from "./website-discovery";

const root = new URL("https://example.com/");
const ok = (url: URL, body: string): WebsiteProbe => ({
	url: url.href,
	body,
	ok: true,
	status: 200,
	error: null,
	contentType: "application/xml",
});

describe("Sitemap evidence discovery", () => {
	it("reads robots declarations, expands indexes and counts unique page URLs rather than index locs", async () => {
		const docs: Record<string, string> = {
			"/custom-index.xml":
				"<sitemapindex><sitemap><loc>/nested.xml.gz</loc></sitemap><sitemap><loc>/custom-index.xml</loc></sitemap></sitemapindex>",
			"/nested.xml.gz":
				"<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b?x=1&amp;y=2</loc></url></urlset>",
		};
		const requested: string[] = [];
		const found = await discoverSitemaps(
			root,
			"User-agent: *\nSitemap: /custom-index.xml",
			'<html><nav><a href="/products">产品</a></nav></html>',
			async (url) => {
				requested.push(url.pathname);
				return docs[url.pathname]
					? ok(url, docs[url.pathname])
					: { ...ok(url, ""), ok: false, status: 404, error: "HTTP 404" };
			},
		);
		expect(found.urls).toEqual(["https://example.com/a", "https://example.com/b?x=1&y=2"]);
		expect(requested.filter((path) => path === "/custom-index.xml")).toHaveLength(1);
		expect(found.documents.find((d) => d.kind === "index")?.urlCount).toBe(0);
		expect(found.navigationLinkCount).toBe(1);
	});
	it("keeps HTML maps and navigation separate; HTTP 200 catch-all HTML is not an XML sitemap", async () => {
		const result = await discoverSitemaps(
			root,
			"",
			'<html><nav><a href="/">首页</a></nav><a href="/map.html">网站地图</a></html>',
			async (url) => ok(url, "<html><body>页面不存在 <loc>https://example.com/fake</loc></body></html>"),
		);
		expect(result.urls).toEqual([]);
		expect(result.htmlSitemapUrls).toEqual(["https://example.com/map.html"]);
		expect(result.documents.find((d) => d.requestedUrl.endsWith("/sitemap.xml"))?.error).toContain("不是 XML");
	});
	it("supports namespace prefixes, rejects non-sitemap XML, and bounds adversarial indexes", async () => {
		expect(parseSitemap('<s:urlset xmlns:s="urn:test"><s:url><s:loc>/a</s:loc></s:url></s:urlset>', root)).toEqual({
			kind: "urlset",
			urls: ["https://example.com/a"],
		});
		expect(parseSitemap("<data><loc>/fake</loc></data>", root)).toEqual({ kind: "invalid", urls: [] });
		const found = await discoverSitemaps(root, "", "", async (url) =>
			ok(
				url,
				`<sitemapindex>${Array.from({ length: 30 }, (_, i) => `<sitemap><loc>/index${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`,
			),
		);
		expect(found.documents.length).toBeLessThanOrEqual(8);
		expect(found.limited).toBe(true);
		expect(found.urls).toEqual([]);
	});
});
