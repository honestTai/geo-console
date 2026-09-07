import type { FrozenBatchConfig } from "@geo/core";
import type { QueryCapture } from "@geo/evidence";
import { aggregationExplanation, type ExplainableMetrics, explainMeasurement, metricGuide } from "@geo/metrics";
import { reportTypeLabel } from "./labels";
import { type EvidenceIndexEntry, evidencePlatformLabel, type ReportAnalysis } from "./report";
import {
	customerBlock,
	escapeReportHtml as e,
	reportBrandStyles,
	reportLogo,
	reportWatermark,
} from "./report-branding";
import { reportFollowup } from "./report-followup";
import { reportLink } from "./report-links";
import { websiteAuditSection } from "./website-report";

const percent = (n: unknown) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "无法判断");
const anchor = (id: string) => `evidence-${encodeURIComponent(id)}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
export const channelBasis = (basis: unknown) =>
	basis === "owned" ? "客户自有渠道" : basis === "observed_source" ? "证据中出现的渠道" : "候选渠道，发布前待核验";
export const articleQuestions = (ids: unknown, config: FrozenBatchConfig): string[] =>
	config.prompts.filter((p) => strings(ids).includes(p.id)).map((p) => p.question);
export function readerDate(value: unknown): string {
	if (!value) return "历史时间未记录";
	const date = new Date(String(value));
	return Number.isNaN(date.getTime())
		? "历史时间格式无法识别"
		: `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "long", timeStyle: "short" }).format(date)}（北京时间）`;
}

function captureEvidenceHtml(c: QueryCapture): string {
	const cited = c.sources.filter((s) => s.isCitation),
		searched = c.sources.filter((s) => !s.isCitation);
	const sourceList = (sources: typeof c.sources) =>
		sources.map((s) => `<li>${reportLink(s.url, s.title || s.url)}<br>${e(s.url)}</li>`).join("");
	const citationMissing =
		c.captureMode === "llm_search_api" && c.sourceVisibility === "unavailable"
			? "平台未提供可核验的来源记录，不能据此断定没有使用外部资料。"
			: "返回记录没有标记明确的最终引用。";
	return `<p><b>${c.status === "complete" ? "已取得回答；是否参与指标请看计算明细" : "未通过采集检查，不作为品牌零分"}</b></p>${c.failureMessage ? `<p>失败记录：${e(c.failureMessage)}</p>` : ""}<h4>AI 回答原文（原文中的判断不代表已核实事实）</h4><pre class="answer">${e(c.answerText || "本次没有可展示的回答正文")}</pre><h4>答案明确引用的页面</h4>${cited.length ? `<ul>${sourceList(cited)}</ul>` : `<p>${citationMissing}</p>`}<h4>搜索过程中出现的页面（不算最终引用）</h4><ul>${sourceList(searched) || "<li>没有保存此类记录</li>"}</ul>`;
}

function otherEvidenceHtml(entry: EvidenceIndexEntry, analysis: ReportAnalysis | undefined): string {
	const extra = analysis?.supplementalEvidence?.find((r) => r.id === entry.id);
	if (extra?.audit)
		return websiteAuditSection(extra.audit).replace(
			'id="website-audit"',
			`id="website-audit-${encodeURIComponent(extra.id)}"`,
		);
	if (extra)
		return `<h4>${extra.kind === "web_search" ? "研究搜索原文（不是监测回答，不参与品牌指标）" : "保存的页面正文"}</h4>${extra.url ? reportLink(extra.url) : ""}<pre class="answer">${e(extra.content)}</pre><p>研究来源（不是监测答案最终引用）：</p>${extra.sourceUrls.map((url) => reportLink(url)).join("<br>")}`;
	const webPage = analysis?.webPages?.find((r) => r.id === entry.id);
	if (webPage)
		return `<p>${reportLink(webPage.url)}</p><h4>保存的页面正文</h4><pre class="answer">${e(webPage.content)}</pre>`;
	if (entry.kind === "audit") return '<a href="#website-audit">查看本次官网截图、定位、建议及源证据</a>';
	return `<p>${entry.url ? reportLink(entry.url) : "历史记录没有保存可展示的正文，不能用最新页面冒充当时证据。"}</p>`;
}
/** Translate legacy administrative wording only in generated prose; never alter quoted evidence. */
export const readerText = (v: unknown): string =>
	String(v ?? "")
		.replace(/V2\s*(?:MetricSnapshot|可报告状态|证据门槛|快照|测量|语义)?/g, "本次检测")
		.replace(/\bMetricSnapshot\b/g, "本次指标记录")
		.replace(/\blimited\b/g, "初步结果，仅供参考")
		.replace(/\bunavailable\b/g, "未提供可核验信息")
		.replace(/\bisCitation=false\b/g, "仅有搜索记录，未标记为最终引用")
		.replace(/\bsourceStatus\b/g, "引用可核验状态")
		.replace(/\bsourceUrls\b/g, "引用链接")
		.replace(/\bquick\b/g, "快速检测");

export function readerPayload(snapshot: Record<string, unknown>) {
	return snapshot.payload as {
		batch: { config: FrozenBatchConfig; metrics: ExplainableMetrics; captures?: QueryCapture[] };
		report: { analysis?: ReportAnalysis; findings?: Record<string, unknown>[]; tasks?: Record<string, unknown>[] };
		agentNarrative?: Record<string, unknown>;
		articles?: Record<string, unknown>[];
		comparison?: Record<string, unknown> | null;
		providerDisclosures?: Array<{ providerId: string; disclosure: string }>;
	};
}

export function reportGuide(snapshot: Record<string, unknown>) {
	const p = readerPayload(snapshot);
	if (p.report.analysis?.readerGuide) return p.report.analysis.readerGuide;
	if (!p.batch.config?.prompts || !p.batch.metrics?.perPlatform) return null;
	return explainMeasurement(p.batch.metrics, p.batch.config, p.batch.captures ?? []);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Deterministic report sections mirror the frozen snapshot and explicitly disclose missing sections.
export function renderReaderReport(snapshot: Record<string, unknown>, screenshot?: string): string {
	const p = readerPayload(snapshot),
		a = p.report.analysis,
		guide = reportGuide(snapshot);
	const customer = p.batch.config?.project ?? { name: "客户", domain: "" };
	const captures = p.batch.captures ?? [],
		index = a?.evidenceIndex ?? [];
	const byId = new Map(index.map((entry) => [entry.id, entry]));
	const refs = (ids: unknown) =>
		strings(ids)
			.map((id) => `<a class="ref" href="#${anchor(id)}">[${byId.get(id)?.n ?? "证据"}]</a>`)
			.join(" ");
	const narrative = p.agentNarrative ?? {},
		reputation = narrative.reputation as Record<string, unknown> | undefined;
	const overall = p.batch.metrics?.overall ?? {};
	const metrics = Object.entries(metricGuide)
		.map(
			([key, g]) =>
				`<tr><th>${e(g.label)}</th><td>${
					key === "medianRecommendationRank"
						? e(overall.medianRecommendationRank ?? "无明确推荐名次")
						: key === "sourceCoverage"
							? Object.entries(p.batch.metrics.perPlatform)
									.map(([id, m]) => `${e(evidencePlatformLabel(id))}：${percent(m.sourceCoverage)}`)
									.join("<br>")
							: percent(overall[key as keyof typeof overall])
				}</td><td>${e(g.meaning)}<br><b>计算：</b>${e(g.formula)}<br><small>${e(g.caution)}</small></td></tr>`,
		)
		.join("");
	const evidenceCard = (entry: EvidenceIndexEntry): string => {
		const capture = captures.find((item) => item.captureId === entry.id);
		return `<article class="evidence-card" id="${anchor(entry.id)}"><h3>[${entry.n}] ${e(entry.question ?? entry.title ?? entry.platformLabel ?? "保存的证据")}</h3><p>${e(entry.platformLabel)} · ${e(readerDate(entry.capturedAt))} ${entry.attempt ? `· 第 ${entry.attempt} 次测试` : ""} <a href="#metrics">数字怎么算</a><a href="#evidence-index">返回证据目录</a></p>${capture ? captureEvidenceHtml(capture) : otherEvidenceHtml(entry, a)}</article>`;
	};
	const findings = a?.gaps ?? p.report.findings ?? [];
	const recs = records(narrative.geoRecommendations);
	const missingIds = [
		...new Set([
			...strings(narrative.evidenceIds),
			...findings.flatMap((f) =>
				strings((f as Record<string, unknown>).evidence_ids ?? (f as Record<string, unknown>).evidenceIds),
			),
			...recs.flatMap((r) => strings(r.evidenceIds)),
			...reportFollowup(p).flatMap((r) => r.evidenceIds),
			...(p.articles ?? []).flatMap((r) => strings(r.evidence_ids)),
		]),
	].filter((id) => !byId.has(id));
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${e(snapshot.title)}</title><style>${reportBrandStyles}
	body{font:14px/1.75 "Noto Sans CJK SC","PingFang SC",sans-serif;color:#1b2924;margin:0}main{max-width:980px;margin:auto;padding:30px}h1{font-size:30px}h2{font-size:22px;border-bottom:2px solid #dce5e0;padding-bottom:8px;margin-top:36px}h3{font-size:17px}a{color:#08795a;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:12px;margin:14px 0}th,td{border:1px solid #dbe3df;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}.notice{background:#f2f5f3;padding:16px;border-left:3px solid #158459}.evidence-card{break-before:page}.answer{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:1.8;background:#f7f8f7;padding:12px}.ref{padding:2px 5px;display:inline-block}.section{margin:28px 0}.metric-help{font-size:12px}small{color:#56645d}.zz-watermark small{color:inherit}nav a{display:inline-block;margin:8px 16px 8px 0}@page{size:A4;margin:18mm 14mm}</style></head><body>${reportWatermark(customer.name)}<main class="zz-content">${reportLogo}<h1>${e(customer.name)}<br>AI 可见度诊断与行动报告</h1><p>${e(reportTypeLabel(snapshot.report_type) || "诊断报告")}</p>${customerBlock({ ...customer, language: customer.language === "zh-CN" ? "简体中文" : customer.language }, readerDate(snapshot.created_at))}
	<nav><a href="#summary">先看结论</a><a href="#problems">问题与行动</a><a href="#website-audit">官网怎么改</a><a href="#articles">文章怎么用</a><a href="#metrics">数字怎么算</a><a href="#evidence-index">回答与引用证据</a></nav>
	<section id="summary"><h2>一、本次测了什么，可以下什么结论？</h2><p>${e(guide?.scope ?? "历史报告缺少完整采样说明，请查看原始配置。")}</p><p>关键数字：品牌提及率 <b>${percent(overall.brandMentionRate)}</b> · 首位推荐率 <b>${percent(overall.firstRecommendationRate)}</b> · 监测品牌出现份额 <b>${percent(overall.monitoredBrandShare)}</b>（不是市场份额）。<a href="#metrics">查看各指标含义与实际分母</a></p><p class="notice">${e(guide?.status ?? "待核验")}。${e(guide?.limitation ?? "不能将本次结果当作固定排名。")}</p>${guide ? `<p><b>${guide.counts.planned} 次计划测试 → ${guide.counts.answered} 次取得回答 → ${guide.counts.parsed} 次通过品牌判断校验。</b>缺失和失败不是企业差评。</p><table><thead><tr><th>问题类型</th><th>可统计 / 计划问题</th><th>品牌提及率</th><th>核对次数</th></tr></thead><tbody>${guide.segments.map((s) => `<tr><td>${e(s.label)}</td><td>${s.eligibleQuestions} / ${s.plannedQuestions}</td><td>${percent(s.mentionRate)}</td><td>${s.mentionAnswers} 次提及 / ${s.validAnswers} 个可判断回答</td></tr>`).join("")}</tbody></table><p>点名提问按已确认公司名称与别名识别，只是问题分组，不是新的排名指标。能回答“公司做什么”，不等于客户不点名时会主动推荐它。</p>` : ""}
	<h3>经审批的业务解读</h3><p>${e(readerText(narrative.executiveSummary ?? a?.executive.summary ?? "暂无已批准解读"))}</p><h3>AI 如何描述公司？不是客户满意度调查</h3><p>${e(readerText(reputation?.summary ?? "尚无可展示的评价证据"))}</p>${[
		...records(reputation?.positiveSignals),
		...records(reputation?.negativeSignals),
	]
		.map(
			(s) =>
				`<article><p>${e(readerText(s.statement))} ${refs(s.evidenceIds)}</p><small>${s.sourceStatus === "cited" ? "回答附有明确引用，但公司事实仍需逐项核实：" : "这只是 AI 的评价，未附可核验最终引用，不能作为公司事实或负面新闻。"}</small>${
					s.sourceStatus === "cited"
						? strings(s.sourceUrls)
								.map((u) => reportLink(u))
								.join("<br>")
						: ""
				}</article>`,
		)
		.join("")}</section>

	<section id="problems"><h2>二、哪里有问题，接下来做什么？</h2>${findings.map((f) => `<article><h3>${e(readerText(f.title))}</h3><p><b>观察到的情况：</b>${e(readerText(f.detail))}</p><p><b>下一步：</b>${e(readerText(f.recommendation))}</p><p>打开依据：${refs((f as Record<string, unknown>).evidence_ids ?? f.evidenceIds)}</p></article>`).join("") || "<p>尚无有证据支持的诊断，不能据此编造问题。</p>"}${recs.map((r) => `<article><h3>${e(r.title)}</h3><p><b>为什么做：</b>${e(readerText(r.rationale))}</p><p><b>怎么做：</b>${e(readerText(r.action))}</p><p><b>由谁处理：</b>${e(r.ownerRole ?? "待分配")}</p><p><b>做完怎么看：</b>${e(r.acceptanceCriteria ?? "先核对该建议对应证据与发布页面，再按原条件复测；不得承诺排名。")}</p>${refs(r.evidenceIds)}</article>`).join("")}${guide?.failures.length ? `<h3>未完成测试逐条说明</h3>${guide.failures.map((f) => `<p>${e(f.question)}：${e(f.reason)}。${e(f.action)} ${refs([f.captureId])}</p>`).join("")}` : ""}</section>
	${reportFollowup(p)
		.map(
			(line) =>
				`<article><h3>${e(line.title)}</h3><p>${e(line.detail)}</p>${refs(line.evidenceIds)}${line.urls.map((url) => reportLink(url)).join("<br>")}</article>`,
		)
		.join("")}
	${a?.websiteAudit ? websiteAuditSection(a.websiteAudit.result, screenshot).replace(/<h2>[^<]*<\/h2>/, "<h2>三、官网怎么改？</h2>") : `<section id="website-audit"><h2>三、官网怎么改？</h2><p>${customer.domain ? "本次没有官网审计证据，不能推断网站缺失哪些功能；先进行官网检查。" : "客户未提供官网，本项不适用。可后补官网后检查；本轮不把官网记为零分。"}</p></section>`}
	<section id="articles"><h2>四、优化文章用来干什么、发在哪里？</h2><p>文章只能解决有事实支持的内容缺口，不能修复网站访问、额度不足或抓取故障。发布是人工动作，保存草稿不代表已发布，更不代表已被 AI 引用。</p>${(p.articles ?? []).map((article) => `<article><h3>${e(article.title)}</h3><p>解决的问题：${e(article.recommendation_title)}</p><p>${e(article.summary)}</p><p>回答的监测问题：${e(articleQuestions(article.target_prompt_ids, p.batch.config).join("；") || "历史文章未保存关联问题，需补充确认")}</p>${publicationPlanHtml(article.publication_plan, refs)}<p>实际发布地址：${article.published_url ? reportLink(article.published_url) : "尚未填写；不能判断已上线"}</p>${refs(article.evidence_ids)}</article>`).join("") || "<p>冻结这份报告时没有可交付文章。请先确认哪些建议需要内容创作，再生成附有用途、读者、发布渠道和验收清单的草稿。</p>"}</section>
	<section id="metrics"><h2>五、每个数字是什么意思、怎么算？</h2><p>${e(aggregationExplanation)}</p><table><thead><tr><th>指标</th><th>本次结果</th><th>含义、公式与注意事项</th></tr></thead><tbody>${metrics}</tbody></table>${guide ? `<h3>完成度的分子和分母</h3><table><thead><tr><th>平台</th><th>采集覆盖</th><th>解析覆盖</th><th>问题覆盖</th></tr></thead><tbody>${guide.platformCounts.map((r) => `<tr><td>${e(evidencePlatformLabel(r.platform))}</td><td>${r.answered} / ${r.planned}</td><td>${r.parsed} / ${r.answered}</td><td>${r.eligibleQuestions} / ${r.plannedQuestions}</td></tr>`).join("")}</tbody></table><h3>逐问题计算明细：哪些算了，哪些没算？</h3><table><thead><tr><th>平台 / 问题</th><th>提及 / 可判断回答</th><th>首位 / 可判断回答</th><th>监测品牌份额</th><th>纳入情况与证据</th></tr></thead><tbody>${guide.calculationRows.map((r) => `<tr><td>${e(evidencePlatformLabel(r.platform))}<br>${e(r.question)}<br>${r.named ? "点名提问" : "不点名提问"}</td><td>${r.mentions ?? "未知"} / ${r.valid}</td><td>${r.first ?? "未知"} / ${r.valid}</td><td>${percent(r.share)}<br>${r.mentions ?? "未知"} / ${r.monitoredMentions ?? "未知"} 次监测品牌提及</td><td>${e(r.reason)} ${refs(r.evidenceIds)}</td></tr>`).join("")}</tbody></table>` : ""}</section>
	<section id="evidence-index"><h2>六、证据目录：点击查看原话与出处</h2>${guide ? `<p>${guide.sources.withSearchSources} 个回答有搜索来源记录；${guide.sources.withFinalCitations} 个回答有明确最终引用，共 ${guide.sources.citationLinks} 条引用记录；${guide.sources.unavailable} 个回答的来源不可观察。两个口径分开统计，不互相替代。</p>` : ""}<p>下面的编号跳转到本文件内保存的回答或页面正文，不需要登录。外部网址指向原站，内容以后可能变化；官网原始文件仍按客户权限在工作台查看。</p><ol>${index.map((entry) => `<li><a href="#${anchor(entry.id)}">[${entry.n}] ${e(entry.question ?? entry.title ?? entry.platformLabel)}</a></li>`).join("")}</ol>${index.map(evidenceCard).join("")}${missingIds.map((id) => `<article id="${anchor(id)}"><h3>未关联到正文的历史证据</h3><p>此引用未进入本报告的证据索引，暂不能复核；不允许用其他证据替代。记录号：${e(id)}</p></article>`).join("")}</section>
	<section><h2>阅读边界</h2>${strings(narrative.limitations)
		.map((s) => `<p>${e(readerText(s))}</p>`)
		.join(
			"",
		)}<p>API 回答不等同于对应消费端 App。这里测试的是服务商提供的接口，不是手机应用界面。</p>${(p.providerDisclosures ?? []).map((d) => `<p>${e(d.disclosure)}</p>`).join("")}<p>本报告只描述所测平台接口在当时的返回结果，不等于消费端应用排名、市场份额或实际客户满意度。整改建议不是完成效果，优化效果必须另行同条件复测。</p></section></main></body></html>`;
}

export function contentStrategySummary(value: unknown): string[] {
	const strategy = value as Record<string, unknown> | null;
	if (!strategy) return ["这篇文章尚未记录内容形式与篇幅依据，需补充或重新生成；不按固定模板补齐。"];
	return [
		`内容形式：${strategy.format || "尚未填写"}`,
		`选择理由：${strategy.rationale || "尚未填写"}`,
		`篇幅安排：${strategy.lengthApproach || "尚未填写"}`,
	];
}

export function publicationPlanHtml(value: unknown, refs: (ids: unknown) => string = () => ""): string {
	const p = value as Record<string, unknown> | null;
	if (!p) return "<p>历史文章未保存用途与发布计划，需补充或重新生成，不能凭正文推测已经发布。</p>";
	return `<p><b>文章用途：</b>${e(p.purpose)}</p><p><b>目标读者：</b>${e(p.audience)}</p><p><b>解决的缺口：</b>${e(p.problem)}</p>${contentStrategySummary(
		p.contentStrategy,
	)
		.map((line) => `<p>${e(line)}</p>`)
		.join("")}<table><thead><tr><th>建议发布位置</th><th>选择理由与调整方式</th></tr></thead><tbody>${records(
		p.channels,
	)
		.map(
			(c) =>
				`<tr><td>${e(c.platform)}<br>${e(c.placement)}<br>${e(channelBasis(c.basis))}${refs(c.evidenceIds)}</td><td>${e(c.reason)}<br>${e(c.adaptation)}<br>发布前确认：${e(c.prerequisite)}</td></tr>`,
		)
		.join("")}</tbody></table><p><b>发布后验收：</b>${strings(p.acceptance).map(e).join("；")}</p>`;
}
