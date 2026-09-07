import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Database, WebsiteAuditResult } from "@geo/core";
import { StructuredLogger, safeErrorMessage } from "@geo/logging";
import { load } from "cheerio";
import { putArtifact } from "./object-store";
import { assertPublicUrl, fetchPublicText, PublicHttpError } from "./public-http";
import { discoverSitemaps, type WebsiteProbe } from "./website-discovery";
import { websiteGuidance } from "./website-guidance";
import { renderWebsiteAuditHtml, websiteAuditPdf } from "./website-report";
import { websiteScreenshot } from "./website-screenshot";

export type CrawledPage = {
	id: string;
	url: string;
	domain: string;
	title: string | null;
	text: string;
	structuredData: unknown[];
	contentHash: string;
};

/** 站内页面并发抓取数：对客户官网保持礼貌，同时让建档不再逐页串行等 15 秒超时。 */
const CRAWL_CONCURRENCY = 4;
const auditUserAgent = "GEOConsole/0.1 (+website evidence audit)";
const auditLogger = new StructuredLogger("api");
const browserUserAgent =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function fetchText(
	url: URL,
	timeoutMs = 15_000,
	userAgent = auditUserAgent,
): Promise<{ body: string; contentType: string; finalUrl: string; status: number }> {
	return fetchPublicText(url, timeoutMs, userAgent);
}

type ProbeResult = WebsiteProbe;

function readableError(error: unknown): string {
	if (!(error instanceof Error)) return "未知网络错误";
	const cause = error.cause;
	if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
	return error.message;
}

async function probeText(url: URL, userAgent = auditUserAgent): Promise<ProbeResult> {
	try {
		const value = await fetchText(url, 15_000, userAgent);
		return {
			ok: true,
			status: value.status,
			url: value.finalUrl,
			body: value.body,
			contentType: value.contentType,
			error: null,
		};
	} catch (error) {
		const message = readableError(error);
		const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? Number.NaN);
		return {
			ok: false,
			status: Number.isFinite(status) ? status : null,
			url: url.href,
			body: error instanceof PublicHttpError ? error.body.toString("utf8") : "",
			contentType: error instanceof PublicHttpError ? error.contentType : "",
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
		hasBrandMention: aliases.some(
			(alias) =>
				alias.trim() &&
				`${$("title").text()} ${$("meta[name='description']").attr("content") ?? ""} ${text} ${JSON.stringify(structuredData)}`
					.toLowerCase()
					.includes(alias.trim().toLowerCase()),
		),
		contentHash: createHash("sha256").update(probe.body).digest("hex"),
	};
}

type DiscoveryAudit = {
	robots: ProbeResult;
	sitemap: ProbeResult;
	llmsTxt: ProbeResult;
	blockedBots: string[];
	sitemapUrlCount: number;
	sitemaps?: Awaited<ReturnType<typeof discoverSitemaps>>;
};

async function inspectDiscovery(
	auditedUrl: URL | null,
	useBrowserAgent: boolean,
	homepageHtml = "",
): Promise<DiscoveryAudit> {
	if (!auditedUrl)
		return { robots: emptyProbe, sitemap: emptyProbe, llmsTxt: emptyProbe, blockedBots: [], sitemapUrlCount: 0 };
	const userAgent = useBrowserAgent ? browserUserAgent : auditUserAgent;
	const [robots, llmsTxt] = await Promise.all([
		probeText(new URL("/robots.txt", auditedUrl.origin), userAgent),
		probeText(new URL("/llms.txt", auditedUrl.origin), userAgent),
	]);
	for (const probe of [robots, llmsTxt])
		if (probe.ok && /<!doctype\s+html|<html(?:\s|>)/i.test(probe.body)) {
			probe.ok = false;
			probe.error = "该地址返回 HTML，不是请求的文本文件（可能为通用错误页）";
		}
	const sitemaps = await discoverSitemaps(auditedUrl, robots.ok ? robots.body : "", homepageHtml, (url) =>
		probeText(url, userAgent),
	);
	const xml =
		sitemaps.documents.find((doc) => doc.kind === "urlset") ?? sitemaps.documents.find((doc) => doc.kind === "index");
	const sitemap: ProbeResult = xml ?? {
		...emptyProbe,
		error: "本次探测范围内未读取到有效 XML Sitemap；请查看逐地址记录，不等于断言全站不存在",
	};
	return {
		robots,
		sitemap,
		llmsTxt,
		blockedBots: robots.ok ? blockedAiBots(robots.body) : [],
		sitemapUrlCount: sitemaps.urls.length,
		sitemaps,
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
			sitemap.ok
				? `XML Sitemap 已解析 ${sitemapUrlCount} 个页面 URL${discovery.sitemaps?.limited ? "（达到扫描上限，非全站总量）" : ""}`
				: `${sitemap.error}；HTML 地图 ${discovery.sitemaps?.htmlSitemapUrls.length ?? 0} 个。页面导航菜单不等同于 XML Sitemap。`,
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
			homepage.hasBrandMention
				? "首页标题、描述、正文或 JSON-LD 匹配已确认品牌名称"
				: "首页已读取内容未匹配已确认品牌名称；简称需要人工确认",
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
			: checks.some((check) => check.status === "fail" || check.status === "warning")
				? "ready_with_warnings"
				: "ready",
		score: homepageProbe ? auditScore(checks) : null,
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
				urls: discovery.sitemaps?.urls.slice(0, 100),
				documents: discovery.sitemaps?.documents.map((doc) => ({
					url: doc.requestedUrl,
					kind: doc.kind,
					status: doc.status,
					error: doc.error,
					urlCount: doc.urlCount,
				})),
				limited: discovery.sitemaps?.limited,
				htmlSitemapUrls: discovery.sitemaps?.htmlSitemapUrls,
				navigationLinkCount: discovery.sitemaps?.navigationLinkCount,
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
	const customer = (
		await database.query<{ name: string; region: string; language: string; industry: string | null }>(
			"SELECT name,region,language,industry FROM projects WHERE id=$1",
			[projectId],
		)
	).rows[0];
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
	const discovery = await inspectDiscovery(auditedUrl, useBrowserAgent, homepageProbe?.body ?? "");
	const checks = buildAuditChecks({ homepageProbe, https, browserFallback, homepage, discovery });
	applyAuditEvidenceLimits(checks, homepageProbe, homepage);
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
	if (customer) result.customer = { ...customer, websiteUrl: requested.href };
	await attachAuditEvidence(projectId, auditId, result, {
		homepage: homepageProbe ?? https,
		robots: discovery.robots,
		llms: discovery.llmsTxt,
		sitemaps: discovery.sitemaps?.documents ?? [],
	});
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

function applyAuditEvidenceLimits(
	checks: WebsiteAuditResult["checks"],
	homepageProbe: ProbeResult | null,
	homepage: WebsiteAuditResult["homepage"],
) {
	if (!homepageProbe) {
		for (const check of checks)
			if (Number(check.id.slice(1)) >= 5) {
				check.status = "skip";
				check.detail = "首页读取失败，本项未验证；不能据此推断标签或业务内容缺失";
			}
		return;
	}
	const languageCheck = checks.find((check) => check.id === "A9");
	if (
		languageCheck &&
		homepage.language &&
		/^en(?:-|$)/i.test(homepage.language) &&
		(load(homepageProbe.body)("body")
			.text()
			.match(/[\p{Script=Han}]/gu)?.length ?? 0) > 50
	) {
		languageCheck.status = "warning";
		languageCheck.detail = `页面声明 ${homepage.language}，但正文包含大量中文，请人工核对主要语言`;
	}
}

async function attachAuditEvidence(
	projectId: string,
	auditId: string,
	result: WebsiteAuditResult,
	probes: { homepage: ProbeResult; robots: ProbeResult; llms: ProbeResult; sitemaps: ProbeResult[] },
) {
	result.schemaVersion = "geo.website-audit.v2";
	result.evidence = [];
	result.screenshotMode = "restricted_browser_render";
	result.limitations = [
		"范围为本次首页与有限发现文件探测，不代表全站内容、完整 JS 交互或 AI 平台索引状态。",
		"截图从本次保存的 HTML 受控渲染，视口 1440×1000，允许展示脚本但禁止 API、表单、嵌入页面和实时连接；不是完整交互测试。资源受限可能影响外观，检查结论仍以保存的源文件为依据。",
		"请求失败表示本次证据不足，不推断内容不存在。元数据与 XML 缺失用源证据定位，不能伪造截图标注。",
		"本报告技术建议需要负责人核验后执行；不保证收录、引用、推荐排名或商业收益。",
	];
	const save = async (
		id: string,
		kind: NonNullable<WebsiteAuditResult["evidence"]>[number]["kind"],
		probe: ProbeResult,
		extension: string,
	) => {
		const hasResponse = probe.status !== null || probe.body.length > 0;
		const objectKey = hasResponse
			? await putArtifact(`website-audits/${projectId}/${auditId}/${id}.${extension}`, probe.body)
			: null;
		result.evidence!.push({
			id,
			kind,
			url: probe.url,
			objectKey,
			contentType: probe.contentType,
			contentHash: hasResponse ? createHash("sha256").update(probe.body).digest("hex") : null,
			status: probe.status,
			error: probe.error,
			excerpt: probe.body.slice(0, 1800),
		});
	};
	await save("homepage", "homepage", probes.homepage, "html");
	await save("robots", "robots", probes.robots, "txt");
	await save("llms", "llms", probes.llms, "txt");
	for (const [index, probe] of probes.sitemaps.entries()) await save(`sitemap-${index + 1}`, "sitemap", probe, "xml");
	for (const check of result.checks) {
		Object.assign(check, websiteGuidance[check.id]);
		check.evidenceIds =
			check.id === "A3"
				? ["robots", "homepage"]
				: check.id === "A4"
					? ["robots", ...result.evidence.filter((item) => item.kind === "sitemap").map((item) => item.id)]
					: check.id === "A13"
						? ["llms"]
						: ["homepage"];
	}
	let screenshot: Buffer | null = null;
	if (probes.homepage.ok) {
		try {
			screenshot = await websiteScreenshot(
				probes.homepage.body,
				probes.homepage.url ?? result.requestedUrl,
				(stats) => {
					result.limitations!.push(
						`浏览器资源：成功读取 ${stats.loaded}，读取失败 ${stats.failed}，因策略或预算阻止 ${stats.blocked}。未加载资源或受限动态功能可能导致页面外观不完整。`,
					);
				},
			);
			const objectKey = await putArtifact(
				`website-audits/${projectId}/${auditId}/homepage.png`,
				screenshot,
				"image/png",
			);
			result.evidence.push({
				id: "screenshot",
				kind: "screenshot",
				url: probes.homepage.url,
				objectKey,
				contentType: "image/png",
				contentHash: createHash("sha256").update(screenshot).digest("hex"),
				status: null,
				error: null,
			});
		} catch (error) {
			auditLogger.warn("audit.screenshot_failed", safeErrorMessage(error), { projectId, traceId: auditId });
			result.evidence.push({
				id: "screenshot",
				kind: "screenshot",
				url: probes.homepage.url,
				objectKey: null,
				contentType: "image/png",
				contentHash: null,
				status: null,
				error: "截图生成失败；源 HTML 和检查结果保留。请检查 Chromium 安装、资源与进程限制后重新审计。",
			});
		}
	}
	const html = renderWebsiteAuditHtml(
		result,
		screenshot ? `data:image/png;base64,${screenshot.toString("base64")}` : undefined,
	);
	const htmlKey = await putArtifact(
		`website-audits/${projectId}/${auditId}/report.html`,
		html,
		"text/html; charset=utf-8",
	);
	result.evidence.push({
		id: "report-html",
		kind: "report",
		url: null,
		objectKey: htmlKey,
		contentType: "text/html",
		contentHash: createHash("sha256").update(html).digest("hex"),
		status: null,
		error: null,
	});
	try {
		const pdf = await websiteAuditPdf(html, result.customer?.name ?? "客户官网");
		const objectKey = await putArtifact(`website-audits/${projectId}/${auditId}/report.pdf`, pdf, "application/pdf");
		result.evidence.push({
			id: "report-pdf",
			kind: "report",
			url: null,
			objectKey,
			contentType: "application/pdf",
			contentHash: createHash("sha256").update(pdf).digest("hex"),
			status: null,
			error: null,
		});
	} catch (error) {
		auditLogger.warn("audit.pdf_failed", safeErrorMessage(error), { projectId, traceId: auditId });
		result.evidence.push({
			id: "report-pdf",
			kind: "report",
			url: null,
			objectKey: null,
			contentType: "application/pdf",
			contentHash: null,
			status: null,
			error: "PDF 生成失败，可先下载完整 HTML 报告；检查 Chromium 后重新审计生成新证据。",
		});
	}
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
	const crawlOne = async (url: URL): Promise<CrawledPage | null> => {
		const { body, contentType, finalUrl } = await fetchText(url, 15_000, userAgent);
		if (!contentType.includes("html")) return null;
		const page = pageFromHtml(new URL(finalUrl), body);
		if (!page.text) return null;
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
		return page;
	};
	// 首页先单独抓：它失败且没有任何页面时整站视为不可读；其余页面按小并发抓取，慢站不再逐页串行等超时。
	const [first, ...rest] = urls;
	if (first) {
		try {
			const page = await crawlOne(first);
			if (page) pages.push(page);
		} catch (error) {
			if (first.href === root.href) throw error;
		}
	}
	const results: Array<CrawledPage | null> = new Array(rest.length).fill(null);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(CRAWL_CONCURRENCY, rest.length) }, async () => {
			while (cursor < rest.length) {
				const index = cursor;
				cursor += 1;
				try {
					results[index] = await crawlOne(rest[index]);
				} catch {
					// 单页不可达只减少证据，不影响其他页面。
				}
			}
		}),
	);
	for (const page of results) if (page) pages.push(page);
	if (pages.length === 0) throw new Error("官网没有可读取的公开 HTML 页面");
	return pages;
}

export async function crawlPublishedUrl(database: Database, projectId: string, url: string): Promise<CrawledPage> {
	const pages = await crawlWebsite(database, projectId, url, 1);
	return pages[0];
}
