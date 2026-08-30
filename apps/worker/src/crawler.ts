import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import type { Database, WebsiteAuditResult } from "@geo/core";
import { load } from "cheerio";
import { putArtifact } from "./object-store";

export type CrawledPage = {
	id: string;
	url: string;
	domain: string;
	title: string | null;
	text: string;
	structuredData: unknown[];
	contentHash: string;
};

const isPrivateAddress = (address: string): boolean =>
	/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(address) ||
	/^172\.(1[6-9]|2\d|3[01])\./.test(address);

async function assertPublicUrl(value: string): Promise<URL> {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("官网只支持 HTTP 或 HTTPS");
	const addresses = await lookup(url.hostname, { all: true });
	if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("不能抓取本机或内网地址");
	return url;
}

const auditUserAgent = "GEOConsole/0.1 (+website evidence audit)";
const browserUserAgent =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function fetchText(
	url: URL,
	timeoutMs = 15_000,
	userAgent = auditUserAgent,
): Promise<{ body: string; contentType: string }> {
	let current = url;
	for (let redirect = 0; redirect <= 5; redirect += 1) {
		await assertPublicUrl(current.href);
		const response = await fetch(current, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "user-agent": userAgent },
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`${current.href} 返回无地址重定向`);
			current = new URL(location, current);
			continue;
		}
		if (!response.ok) throw new Error(`${current.href} 返回 HTTP ${response.status}`);
		return { body: await response.text(), contentType: response.headers.get("content-type") ?? "" };
	}
	throw new Error(`${url.href} 重定向次数过多`);
}

type ProbeResult = {
	ok: boolean;
	status: number | null;
	url: string | null;
	body: string;
	contentType: string;
	error: string | null;
};

function readableError(error: unknown): string {
	if (!(error instanceof Error)) return "未知网络错误";
	const cause = error.cause;
	if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
	return error.message;
}

async function probeText(url: URL, userAgent = auditUserAgent): Promise<ProbeResult> {
	try {
		const value = await fetchText(url, 15_000, userAgent);
		return { ok: true, status: 200, url: url.href, body: value.body, contentType: value.contentType, error: null };
	} catch (error) {
		const message = readableError(error);
		const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? Number.NaN);
		return {
			ok: false,
			status: Number.isFinite(status) ? status : null,
			url: null,
			body: "",
			contentType: "",
			error: message.slice(0, 500),
		};
	}
}

function structuredDataTypes(items: unknown[]): string[] {
	const types = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		const type = record["@type"];
		if (typeof type === "string") types.add(type);
		if (Array.isArray(type))
			type
				.filter((item): item is string => typeof item === "string")
				.forEach((item) => {
					types.add(item);
				});
		if (record["@graph"]) visit(record["@graph"]);
	};
	items.forEach(visit);
	return [...types].sort((left, right) => left.localeCompare(right));
}

const monitoredBots = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended"];

function blockedAiBots(robots: string): string[] {
	const blocked = new Set<string>();
	let agents: string[] = [];
	for (const rawLine of robots.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key === "user-agent") {
			agents = [value];
			continue;
		}
		if (key !== "disallow" || value !== "/") continue;
		for (const bot of monitoredBots)
			if (agents.some((agent) => agent === "*" || agent.toLowerCase() === bot.toLowerCase())) blocked.add(bot);
	}
	return [...blocked];
}

function auditCheck(
	id: string,
	label: string,
	status: "pass" | "warning" | "fail" | "skip",
	detail: string,
	weight: number,
): WebsiteAuditResult["checks"][number] {
	return { id, label, status, detail, weight };
}

function auditScore(checks: WebsiteAuditResult["checks"]): number {
	const applicable = checks.filter((check) => check.status !== "skip" && check.weight > 0);
	const possible = applicable.reduce((sum, check) => sum + check.weight, 0);
	const earned = applicable.reduce(
		(sum, check) => sum + check.weight * (check.status === "pass" ? 1 : check.status === "warning" ? 0.5 : 0),
		0,
	);
	return possible ? Math.round((earned / possible) * 100) : 0;
}

const emptyProbe: ProbeResult = {
	ok: false,
	status: null,
	url: null,
	body: "",
	contentType: "",
	error: "首页不可访问",
};

function emptyHomepage(): WebsiteAuditResult["homepage"] {
	return {
		auditedUrl: null,
		auditedWith: null,
		title: null,
		description: null,
		canonical: null,
		language: null,
		h1Count: 0,
		h2Count: 0,
		wordCount: 0,
		structuredDataTypes: [],
		hasContactSignals: false,
		hasBrandMention: false,
		contentHash: null,
	};
}

function analyzeAuditHomepage(
	probe: ProbeResult | null,
	auditedUrl: URL | null,
	aliases: string[],
	auditedWith: "standard_audit" | "browser_fallback",
): WebsiteAuditResult["homepage"] {
	if (!probe || !auditedUrl) return emptyHomepage();
	const $ = load(probe.body);
	const structuredData = $("script[type='application/ld+json']")
		.map((_index, element) => {
			try {
				return JSON.parse($(element).text());
			} catch {
				return null;
			}
		})
		.get()
		.filter(Boolean);
	$("script,style,noscript,svg").remove();
	const text = $("body").text().replace(/\s+/g, " ").trim();
	return {
		auditedUrl: auditedUrl.href,
		auditedWith,
		title: $("title").first().text().trim() || null,
		description: $("meta[name='description']").attr("content")?.trim() || null,
		canonical: $("link[rel='canonical']").attr("href")?.trim() || null,
		language: $("html").attr("lang")?.trim() || null,
		h1Count: $("h1").length,
		h2Count: $("h2").length,
		wordCount: text.match(/[\p{Script=Han}]|[A-Za-z0-9]+/gu)?.length ?? 0,
		structuredDataTypes: structuredDataTypes(structuredData),
		hasContactSignals: /(?:电话|热线|联系|地址|邮箱|email|tel|contact)/i.test(text),
		hasBrandMention: aliases.some((alias) => alias.trim() && text.toLowerCase().includes(alias.trim().toLowerCase())),
		contentHash: createHash("sha256").update(probe.body).digest("hex"),
	};
}

type DiscoveryAudit = {
	robots: ProbeResult;
	sitemap: ProbeResult;
	llmsTxt: ProbeResult;
	blockedBots: string[];
	sitemapUrlCount: number;
};

async function inspectDiscovery(auditedUrl: URL | null, useBrowserAgent: boolean): Promise<DiscoveryAudit> {
	if (!auditedUrl)
		return { robots: emptyProbe, sitemap: emptyProbe, llmsTxt: emptyProbe, blockedBots: [], sitemapUrlCount: 0 };
	const userAgent = useBrowserAgent ? browserUserAgent : auditUserAgent;
	const robots = await probeText(new URL("/robots.txt", auditedUrl.origin), userAgent);
	let sitemap = await probeText(new URL("/sitemap.xml", auditedUrl.origin), userAgent);
	if (!sitemap.ok) sitemap = await probeText(new URL("/sitemap_index.xml", auditedUrl.origin), userAgent);
	const llmsTxt = await probeText(new URL("/llms.txt", auditedUrl.origin), userAgent);
	return {
		robots,
		sitemap,
		llmsTxt,
		blockedBots: robots.ok ? blockedAiBots(robots.body) : [],
		sitemapUrlCount: sitemap.ok ? (sitemap.body.match(/<loc(?:\s|>)/gi) ?? []).length : 0,
	};
}

// Keep the fixed audit rubric together so score weights and user-facing evidence stay reviewable as one contract.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each branch maps one published audit check to a status
function buildAuditChecks(input: {
	homepageProbe: ProbeResult | null;
	https: ProbeResult;
	browserFallback: ProbeResult | null;
	homepage: WebsiteAuditResult["homepage"];
	discovery: DiscoveryAudit;
}): WebsiteAuditResult["checks"] {
	const { homepageProbe, https, browserFallback, homepage, discovery } = input;
	const { robots, sitemap, llmsTxt, blockedBots, sitemapUrlCount } = discovery;
	return [
		auditCheck(
			"A1",
			"首页公开可访问",
			homepageProbe ? "pass" : "fail",
			homepageProbe ? `HTTP ${homepageProbe.status}` : "HTTPS 与 HTTP 均不可读取",
			20,
		),
		auditCheck("A2", "HTTPS 证书与访问", https.ok ? "pass" : "fail", https.error ?? "HTTPS 可正常访问", 15),
		auditCheck(
			"A3",
			"AI 搜索机器人权限",
			browserFallback?.ok ? "fail" : !robots.ok ? "warning" : blockedBots.length ? "fail" : "pass",
			browserFallback?.ok
				? "普通浏览器 UA 可访问，但审计 UA 被拒绝；需检查 WAF/CDN 的机器人访问策略"
				: !robots.ok
					? "未读取到 robots.txt"
					: blockedBots.length
						? `全站阻止：${blockedBots.join("、")}`
						: "未发现已知 AI 搜索机器人被全站阻止",
			10,
		),
		auditCheck(
			"A4",
			"Sitemap 发现",
			sitemap.ok && sitemapUrlCount > 0 ? "pass" : "warning",
			sitemap.ok ? `发现 ${sitemapUrlCount} 个 URL` : "未发现可读取的 Sitemap",
			8,
		),
		auditCheck("A5", "页面标题", homepage.title ? "pass" : "fail", homepage.title ?? "缺少 title", 8),
		auditCheck(
			"A6",
			"页面描述",
			homepage.description ? "pass" : "warning",
			homepage.description ?? "缺少 meta description",
			6,
		),
		auditCheck("A7", "主标题结构", homepage.h1Count === 1 ? "pass" : "warning", `检测到 ${homepage.h1Count} 个 H1`, 6),
		auditCheck("A8", "Canonical", homepage.canonical ? "pass" : "warning", homepage.canonical ?? "未声明 canonical", 5),
		auditCheck("A9", "页面语言", homepage.language ? "pass" : "warning", homepage.language ?? "HTML 未声明 lang", 4),
		auditCheck(
			"A10",
			"结构化数据",
			homepage.structuredDataTypes.length ? "pass" : "warning",
			homepage.structuredDataTypes.length ? homepage.structuredDataTypes.join("、") : "首页未发现 JSON-LD",
			8,
		),
		auditCheck(
			"A11",
			"品牌实体一致性",
			homepage.hasBrandMention ? "pass" : "warning",
			homepage.hasBrandMention ? "首页正文包含已确认品牌名称" : "首页正文未匹配已确认品牌名称",
			5,
		),
		auditCheck(
			"A12",
			"联系与主体信号",
			homepage.hasContactSignals ? "pass" : "warning",
			homepage.hasContactSignals ? "检测到联系或地址信号" : "首页未检测到明显联系信息",
			5,
		),
		auditCheck(
			"A13",
			"llms.txt",
			llmsTxt.ok ? "pass" : "skip",
			llmsTxt.ok ? "已提供 llms.txt" : "未提供；该文件不是排名或收录的必要条件",
			0,
		),
	];
}

function composeAuditResult(input: {
	requested: URL;
	https: ProbeResult;
	httpFallback: ProbeResult | null;
	browserFallback: ProbeResult | null;
	homepageProbe: ProbeResult | null;
	homepage: WebsiteAuditResult["homepage"];
	discovery: DiscoveryAudit;
	checks: WebsiteAuditResult["checks"];
}): WebsiteAuditResult {
	const { requested, https, httpFallback, browserFallback, homepageProbe, homepage, discovery, checks } = input;
	return {
		requestedUrl: requested.href,
		checkedAt: new Date().toISOString(),
		verdict: !homepageProbe
			? "blocked"
			: checks.some((check) => check.status === "fail")
				? "ready_with_warnings"
				: "ready",
		score: auditScore(checks),
		transport: {
			https: { ok: https.ok, status: https.status, error: https.error },
			httpFallback: {
				checked: Boolean(httpFallback),
				ok: Boolean(httpFallback?.ok),
				status: httpFallback?.status ?? null,
				error: httpFallback?.error ?? null,
			},
			browserFallback: {
				checked: Boolean(browserFallback),
				ok: Boolean(browserFallback?.ok),
				status: browserFallback?.status ?? null,
				error: browserFallback?.error ?? null,
			},
		},
		homepage,
		discovery: {
			robots: {
				ok: discovery.robots.ok,
				status: discovery.robots.status,
				blockedBots: discovery.blockedBots,
				error: discovery.robots.error,
			},
			sitemap: {
				ok: discovery.sitemap.ok,
				status: discovery.sitemap.status,
				urlCount: discovery.sitemapUrlCount,
				error: discovery.sitemap.error,
			},
			llmsTxt: {
				ok: discovery.llmsTxt.ok,
				status: discovery.llmsTxt.status,
				error: discovery.llmsTxt.error,
			},
		},
		checks,
	};
}

export async function auditWebsite(
	database: Database,
	projectId: string,
	websiteUrl: string,
	aliases: string[],
): Promise<{ id: string; result: WebsiteAuditResult }> {
	const requested = await assertPublicUrl(websiteUrl);
	const httpsUrl = new URL(requested.href);
	httpsUrl.protocol = "https:";
	const httpUrl = new URL(requested.href);
	httpUrl.protocol = "http:";
	const https = await probeText(httpsUrl);
	const httpFallback = https.ok ? null : await probeText(httpUrl);
	let browserFallback: ProbeResult | null = null;
	if (!https.ok && !httpFallback?.ok) {
		browserFallback = await probeText(httpsUrl, browserUserAgent);
		if (!browserFallback.ok) browserFallback = await probeText(httpUrl, browserUserAgent);
	}
	const standardHomepageProbe = https.ok ? https : httpFallback?.ok ? httpFallback : null;
	const homepageProbe = standardHomepageProbe ?? (browserFallback?.ok ? browserFallback : null);
	const auditedUrl = homepageProbe?.url ? new URL(homepageProbe.url) : null;
	const useBrowserAgent = !standardHomepageProbe && Boolean(browserFallback?.ok);
	const homepage = analyzeAuditHomepage(
		homepageProbe,
		auditedUrl,
		aliases,
		useBrowserAgent ? "browser_fallback" : "standard_audit",
	);
	const discovery = await inspectDiscovery(auditedUrl, useBrowserAgent);
	const checks = buildAuditChecks({ homepageProbe, https, browserFallback, homepage, discovery });
	const result = composeAuditResult({
		requested,
		https,
		httpFallback,
		browserFallback,
		homepageProbe,
		homepage,
		discovery,
		checks,
	});
	const auditId = randomUUID();
	await database.query(
		"INSERT INTO website_audits (id,project_id,requested_url,result,result_hash,checked_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6)",
		[
			auditId,
			projectId,
			requested.href,
			JSON.stringify(result),
			createHash("sha256").update(JSON.stringify(result)).digest("hex"),
			result.checkedAt,
		],
	);
	return { id: auditId, result };
}

function pageFromHtml(url: URL, html: string): CrawledPage {
	const $ = load(html);
	const structuredData = $("script[type='application/ld+json']")
		.map((_index, element) => {
			try {
				return JSON.parse($(element).text());
			} catch {
				return null;
			}
		})
		.get()
		.filter(Boolean);
	$("script,style,noscript,svg,nav,footer").remove();
	const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 120_000);
	return {
		id: randomUUID(),
		url: url.href,
		domain: url.hostname.toLowerCase().replace(/^www\./, ""),
		title: $("title").first().text().trim() || null,
		text,
		structuredData,
		contentHash: createHash("sha256").update(html).digest("hex"),
	};
}

function addCandidates(target: Map<string, URL>, candidates: URL[], root: URL, limit: number): void {
	for (const candidate of candidates) {
		if (candidate.hostname === root.hostname && !target.has(candidate.href)) target.set(candidate.href, candidate);
		if (target.size >= limit) return;
	}
}

async function sitemapCandidates(root: URL, path: string, userAgent: string): Promise<URL[]> {
	try {
		const { body } = await fetchText(new URL(path, root.origin), 15_000, userAgent);
		const $ = load(body, { xmlMode: true });
		return $("loc")
			.map((_index, element) => {
				try {
					return new URL($(element).text().trim(), root.origin);
				} catch {
					return null;
				}
			})
			.get()
			.filter((candidate): candidate is URL => candidate instanceof URL);
	} catch {
		return [];
	}
}

async function expandedSitemapCandidates(root: URL, path: string, userAgent: string): Promise<URL[]> {
	const initial = await sitemapCandidates(root, path, userAgent);
	const nested = initial
		.filter((url) => url.hostname === root.hostname && /\.xml(?:$|\?)/i.test(url.href))
		.slice(0, 10);
	if (!nested.length) return initial;
	const expanded = await Promise.all(nested.map((url) => sitemapCandidates(root, url.href, userAgent)));
	return expanded.flat();
}

async function homepageCandidates(root: URL, userAgent: string): Promise<URL[]> {
	const { body } = await fetchText(root, 15_000, userAgent);
	const $ = load(body);
	return $("a[href]")
		.map((_index, element) => {
			try {
				const candidate = new URL($(element).attr("href") ?? "", root);
				candidate.hash = "";
				return candidate;
			} catch {
				return null;
			}
		})
		.get()
		.filter((candidate): candidate is URL => candidate instanceof URL);
}

async function discoverUrls(root: URL, limit: number, userAgent: string): Promise<URL[]> {
	const urls = new Map<string, URL>([[root.href, root]]);
	for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
		addCandidates(urls, await expandedSitemapCandidates(root, path, userAgent), root, limit);
		if (urls.size >= limit) return [...urls.values()];
	}
	if (urls.size === 1) addCandidates(urls, await homepageCandidates(root, userAgent), root, limit);
	return [...urls.values()].slice(0, limit);
}

async function resolveCrawlAccess(requested: URL): Promise<{ root: URL; userAgent: string }> {
	const urls = [requested];
	if (requested.protocol === "https:") {
		const http = new URL(requested);
		http.protocol = "http:";
		urls.push(http);
	}
	let lastError: unknown;
	for (const userAgent of [auditUserAgent, browserUserAgent])
		for (const root of urls)
			try {
				await fetchText(root, 15_000, userAgent);
				return { root, userAgent };
			} catch (error) {
				lastError = error;
			}
	throw lastError instanceof Error ? lastError : new Error("官网没有可读取的公开 HTML 页面");
}

export async function crawlWebsite(
	database: Database,
	projectId: string,
	websiteUrl: string,
	limit = 100,
): Promise<CrawledPage[]> {
	const requested = await assertPublicUrl(websiteUrl);
	const { root, userAgent } = await resolveCrawlAccess(requested);
	const urls = await discoverUrls(root, Math.min(100, Math.max(1, limit)), userAgent);
	const pages: CrawledPage[] = [];
	for (const url of urls) {
		try {
			const { body, contentType } = await fetchText(url, 15_000, userAgent);
			if (!contentType.includes("html")) continue;
			const page = pageFromHtml(url, body);
			if (!page.text) continue;
			const artifactKey = join("websites", projectId, `${page.id}.html`);
			await putArtifact(artifactKey, body, "text/html; charset=utf-8");
			await database.query(
				`INSERT INTO website_snapshots
				(id, project_id, url, domain, title, content_text, structured_data, content_hash, artifact_key, fetched_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now())`,
				[
					page.id,
					projectId,
					page.url,
					page.domain,
					page.title,
					page.text,
					JSON.stringify(page.structuredData),
					page.contentHash,
					artifactKey,
				],
			);
			pages.push(page);
		} catch (error) {
			if (url.href === root.href && pages.length === 0) throw error;
		}
	}
	if (pages.length === 0) throw new Error("官网没有可读取的公开 HTML 页面");
	return pages;
}

export async function crawlPublishedUrl(database: Database, projectId: string, url: string): Promise<CrawledPage> {
	const pages = await crawlWebsite(database, projectId, url, 1);
	return pages[0];
}
