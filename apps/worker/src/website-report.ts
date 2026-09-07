import type { WebsiteAuditResult } from "@geo/core";
import { websiteCheckLanguage, websiteScoreBreakdown, websiteScoreGuide } from "@geo/evidence";
import {
	customerBlock,
	escapeReportHtml as e,
	reportBrandStyles,
	reportLogo,
	reportWatermark,
} from "./report-branding";
import { reportLink } from "./report-links";
import { websiteGuidance } from "./website-guidance";
import { launchEvidenceBrowser } from "./website-screenshot";

const states = { pass: "通过", warning: "需优化", fail: "阻断", skip: "参考 / 未验证" };
export function websiteAuditSection(result: WebsiteAuditResult, screenshot?: string): string {
	const checks = [...result.checks].sort(
		(a, b) =>
			({ fail: 0, warning: 1, pass: 2, skip: 3 })[a.status] - { fail: 0, warning: 1, pass: 2, skip: 3 }[b.status],
	);
	return `<section class="section zz-appendix" id="website-audit"><h2>官网技术审计与证据</h2>
	<p>审计 URL：${e(result.requestedUrl)} · ${e(result.checkedAt)} · ${result.score === null ? "未形成可评分证据" : `首页技术检查 ${e(result.score)}/100（不是 AI 排名分数）`}</p>
	${result.customer ? customerBlock(result.customer, result.checkedAt) : ""}
	<p>${e(websiteScoreGuide.formula)} ${result.score === null ? "没有可评分证据，不按零分补齐。" : e(websiteScoreBreakdown(checks))}</p>
	<p>范围：本次已读取首页、robots.txt 与已探测的站点地图；不能由首页检查推断全站。导航菜单不等同 XML Sitemap。</p>
	${screenshot ? `<figure><img class="zz-evidence" src="${e(screenshot)}" alt="本次首页取证截图"><figcaption>已保存 HTML 的浏览器截图（${result.screenshotMode === "restricted_browser_render" ? "受控展示脚本，网络与交互受限" : "脚本禁用"}）；不可见的 meta/robots/XML 问题请看源证据，图片不含虚构标注。</figcaption></figure>` : "<p>截图请在工作台打开本次审计证据；旧审计或取证失败可能没有截图。</p>"}
	<h3>执行摘要与处理顺序</h3><p>${checks.filter((c) => c.status === "fail").length} 项未通过、${checks.filter((c) => c.status === "warning").length} 项待复核。只处理本次未通过或待复核项目；已经通过的项目保持现状，不重复安排整改。先打开证据确认，再由对应负责人修改；参考项不作为收录承诺。</p>
	${checks
		.map((check) => {
			const guide = websiteGuidance[check.id];
			const language = websiteCheckLanguage[check.id];
			return `<article class="zz-audit-check"><h3>${e(language?.label ?? check.label)} · ${states[check.status]}</h3><p>${e(language?.meaning ?? "只描述本次已观察到的页面信号，不推断排名原因。")}</p><p><b>观察事实：</b>${e(check.detail)}</p><p><b>在哪里改：</b>${reportLink(result.requestedUrl)} · ${e(check.selector ?? guide?.selector ?? "见源证据")}</p><p><b>由谁处理：</b>${e(language?.owner ?? "网站负责人")}</p><p><b>处理建议：</b>${e(check.status === "pass" ? "本项已通过，保持现状，无需为这一项安排整改。" : (check.recommendation ?? guide?.recommendation ?? "先复核源证据，再决定是否修改"))}</p><p><b>验收办法：</b>${e(check.verification ?? guide?.verification ?? "在相同网址重新检查")}</p><p><b>点击查看依据：</b>${check.evidenceIds?.map((id) => `<a href="#audit-source-${encodeURIComponent(id)}">源文件 ${e(id.slice(0, 8))}</a>`).join("、") || "历史审计未提供逐项源文件，不能假装已有截图定位"}</p></article>`;
		})
		.join("")}
	<h3>Sitemap 探测记录</h3><p>已解析页面 URL：${e(result.discovery.sitemap.urlCount)}${result.discovery.sitemap.limited ? "（扫描达到上限，非全站总量）" : ""}；HTML 网站地图：${e(result.discovery.sitemap.htmlSitemapUrls?.length ?? "历史未记录")}。</p>
	<table class="zz-evidence-table"><thead><tr><th>请求地址</th><th>类型 / 状态</th><th>结果</th></tr></thead><tbody>${(result.discovery.sitemap.documents ?? []).map((doc) => `<tr><td>${e(doc.url)}</td><td>${e(doc.kind)} / ${e(doc.status ?? "未取得响应")}</td><td>${e(doc.error ?? `${doc.urlCount} 个页面 URL`)}</td></tr>`).join("")}</tbody></table>
	<h3>原始证据索引</h3>${(result.evidence ?? []).map((item) => `<article id="audit-source-${encodeURIComponent(item.id)}"><b>源证据 ${e(item.id)} · ${e(item.kind)}</b><p>${reportLink(item.url)} · HTTP ${e(item.status ?? "不适用")} · SHA-256 ${e(item.contentHash ?? "无原始正文")}</p>${item.error ? `<p>${e(item.error)}</p>` : ""}${item.excerpt ? `<pre>${e(item.excerpt)}</pre>` : "<p>此项未保存可打印的正文摘录；完整文件按项目权限在官网证据详情中查看。</p>"}</article>`).join("")}
	<h3>实施与复验清单</h3><ol><li>技术负责人处理阻断项，保留上线前后证据。</li><li>内容负责人复核标题、主体名称与结构化事实，不用模型臆造资质、案例或数据。</li><li>修改上线后新建官网审计，对照相同 URL 与规则；AI 效果使用原基线完整冻结配置另建复测，不改历史数据。</li></ol>
	<h3>边界与不确定性</h3>${(result.limitations ?? ["历史审计没有保存详细取证说明。"]).map((line) => `<p>${e(line)}</p>`).join("")}</section>`;
}

export function renderWebsiteAuditHtml(result: WebsiteAuditResult, screenshot?: string): string {
	const name = result.customer?.name ?? "客户官网";
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(name)} · ZZGEO 官网审计报告</title><style>${reportBrandStyles}body{margin:0;font:14px/1.7 "Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;color:#17241f}main{max-width:980px;margin:auto;padding:32px}h1{font-size:28px;border-bottom:3px solid #13a65a;padding-bottom:20px}h2{margin-top:30px}table{border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:8px}p{overflow-wrap:anywhere}@page{size:A4;margin:18mm 14mm}</style></head><body>${reportWatermark(name)}<main class="zz-content">${reportLogo}<h1>${e(name)}<br>官网 GEO 技术诊断与优化报告</h1>${websiteAuditSection(result, screenshot)}<p>ZZGEO · 真实观察 · 可追溯证据 · 不承诺固定排名</p></main></body></html>`;
}

export async function websiteAuditPdf(html: string, customer: string): Promise<Buffer> {
	const browser = await launchEvidenceBrowser();
	const deadline = setTimeout(() => void browser.close().catch(() => undefined), 25_000);
	deadline.unref();
	try {
		const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
		await context.route("**/*", (route) => route.abort());
		const page = await context.newPage();
		await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
		return await page.pdf({
			format: "A4",
			printBackground: true,
			displayHeaderFooter: true,
			headerTemplate: `<div style="font:9px sans-serif;width:100%;margin:0 14mm;color:#666">ZZGEO · ${e(customer)} · 官网审计</div>`,
			footerTemplate:
				'<div style="font:9px sans-serif;width:100%;margin:0 14mm;text-align:right;color:#666">ZZGEO · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
			margin: { top: "20mm", right: "14mm", bottom: "18mm", left: "14mm" },
		});
	} finally {
		clearTimeout(deadline);
		await browser.close();
	}
}
