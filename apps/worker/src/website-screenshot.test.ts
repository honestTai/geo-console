import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { staticEvidenceHtml } from "./website-screenshot";

describe("static screenshot document", () => {
	it("preserves the resolved CMS asset base without executing original scripts or frames", () => {
		const html = staticEvidenceHtml(
			'<html><head><base href="/templates/site/"><link rel="stylesheet" href="css/main.css"><script>alert(1)</script></head><body><img src="logo.png"><iframe src="https://example.com"></iframe></body></html>',
			"https://example.com/index.htm",
		);
		const $ = load(html);
		expect($("base").attr("href")).toBe("https://example.com/templates/site/");
		expect($("script,iframe").length).toBe(0);
		expect($("link").attr("href")).toBe("css/main.css");
		expect($("body").text()).toContain("脚本禁用");
	});
	it("uses the final URL for invalid or non-HTTP bases", () => {
		for (const base of ["javascript:alert(1)", "file:///tmp/"]) {
			const $ = load(staticEvidenceHtml(`<base href="${base}">`, "https://example.com/path/"));
			expect($("base").attr("href")).toBe("https://example.com/path/");
		}
	});
	it("allows display scripts only with a deny-by-default content policy", () => {
		const $ = load(
			staticEvidenceHtml(
				'<script src="show.js"></script><iframe src="https://example.com"></iframe>',
				"https://example.com/",
				true,
			),
		);
		expect($("script").length).toBe(1);
		expect($("iframe").length).toBe(0);
		expect($("meta[http-equiv]").attr("content")).toContain("connect-src 'none'");
		expect($("meta[http-equiv]").attr("content")).toContain("form-action 'none'");
	});
});
