import { websiteCheckLanguage, websiteScoreBreakdown, websiteScoreGuide } from "@geo/evidence";
import { aggregationExplanation, metricGuide } from "@geo/metrics";
import { type EvidenceIndexEntry, evidencePlatformLabel } from "./report";
import { escapeReportHtml as xml } from "./report-branding";
import { reportFollowup } from "./report-followup";
import {
	articleQuestions,
	channelBasis,
	contentStrategySummary,
	readerDate,
	readerPayload,
	readerText,
	reportGuide,
} from "./report-reader";
import { websiteGuidance } from "./website-guidance";

const paragraph = (value: unknown, heading = false) =>
	String(value ?? "")
		.split("\n")
		.map(
			(text) =>
				`<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`,
		)
		.join("");
const percent = (n: unknown) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "无法判断");
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const sourceLabel = (s: { title: string | null; url: string }) => s.title || s.url;
const entryLabel = (entry: EvidenceIndexEntry) => entry.question ?? entry.title ?? entry.platformLabel;

function wordAuditImage(screenshot: Buffer | undefined, relationships: string[]): string {
	const image =
		screenshot &&
		screenshot.length >= 24 &&
		screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			? { width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) }
			: null;
	if (image?.width && image.height)
		relationships.push(
			'<Relationship Id="readerAuditImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/audit.png"/>',
		);
	const scale = image?.width && image.height ? Math.min(5400000 / image.width, 5800000 / image.height) : 0;
	const cx = Math.round((image?.width ?? 0) * scale),
		cy = Math.round((image?.height ?? 0) * scale);
	return image?.width && image.height
		? `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="保存的官网截图"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="audit.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="readerAuditImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
		: paragraph("本次没有可嵌入的截图；不使用实时页面补写历史证据。");
}

/** Native Word bookmarks and hyperlinks, not inert citation text or HTML requiring a browser. */
export function readerWordBody(snapshot: Record<string, unknown>, screenshot?: Buffer) {
	const p = readerPayload(snapshot),
		a = p.report.analysis,
		guide = reportGuide(snapshot);
	const entries = a?.evidenceIndex ?? [],
		narrative = p.agentNarrative ?? {};
	const relationships: string[] = [];
	const auditImage = wordAuditImage(screenshot, relationships);
	const link = (url: unknown, label?: unknown) => {
		try {
			const parsed = new URL(String(url));
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
				return paragraph("不支持的链接");
			const id = `readerLink${relationships.length + 1}`;
			relationships.push(
				`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(parsed.href)}" TargetMode="External"/>`,
			);
			return `<w:p><w:hyperlink r:id="${id}"><w:r><w:rPr><w:color w:val="08795A"/><w:u w:val="single"/></w:rPr><w:t>${xml(label ?? url)}</w:t></w:r></w:hyperlink></w:p>`;
		} catch {
			return paragraph(label ?? "未提供可访问地址");
		}
	};
	const refs = (ids: unknown) =>
		strings(ids)
			.map((id) => {
				const entry = entries.find((r) => r.id === id);
				return entry
					? `<w:p><w:hyperlink w:anchor="evidence_${entry.n}"><w:r><w:rPr><w:color w:val="08795A"/><w:u w:val="single"/></w:rPr><w:t>查看证据 [${entry.n}] ${xml(entry.question ?? entry.title ?? entry.platformLabel)}</w:t></w:r></w:hyperlink></w:p>`
					: paragraph("引用未关联到本报告正文，暂不可核验；不以其他证据替代。");
			})
			.join("");
	const body = [
		paragraph("Z · ZZGEO", true),
		paragraph(snapshot.title, true),
		paragraph(
			`客户：${p.batch.config.project.name}；官网：${p.batch.config.project.domain || "未提供（不适用）"}；报告时间：${readerDate(snapshot.created_at)}`,
		),
		paragraph("一、本次测了什么", true),
		paragraph(guide?.scope),
		paragraph(guide?.status),
		paragraph(guide?.limitation),
		guide
			? paragraph(
					`${guide.counts.planned} 次计划 → ${guide.counts.answered} 次取得回答 → ${guide.counts.parsed} 次通过品牌判断校验。完成度不是企业得分。`,
				)
			: "",
		...(guide?.segments ?? []).map((s) =>
			paragraph(
				`${s.label}：${s.eligibleQuestions}/${s.plannedQuestions} 个问题可计算，提及率 ${percent(s.mentionRate)}；核对 ${s.mentionAnswers} 次提及 / ${s.validAnswers} 个可判断回答（次数不替代等权总分）。`,
			),
		),
		paragraph(readerText(narrative.executiveSummary ?? a?.executive.summary)),

		paragraph("二、问题、改法与验收", true),
		...(a?.gaps ?? p.report.findings ?? []).flatMap((f) => [
			paragraph(readerText(f.title), true),
			paragraph(readerText(f.detail)),
			paragraph(`下一步：${readerText(f.recommendation)}`),
			refs((f as Record<string, unknown>).evidence_ids ?? f.evidenceIds),
		]),
		...rows(narrative.geoRecommendations).flatMap((r) => [
			paragraph(r.title, true),
			paragraph(
				`为什么：${readerText(r.rationale)}\n怎么做：${readerText(r.action)}\n负责人：${r.ownerRole ?? "待分配"}\n验收：${r.acceptanceCriteria ?? "需先确认验收办法，不承诺排名"}`,
			),
			refs(r.evidenceIds),
		]),
		paragraph("AI 如何评价公司（不是事实鉴定或客户满意度调查）", true),
		...[
			...rows((narrative.reputation as Record<string, unknown> | undefined)?.positiveSignals),
			...rows((narrative.reputation as Record<string, unknown> | undefined)?.negativeSignals),
		].flatMap((r) => [
			paragraph(readerText(r.statement)),
			paragraph(
				r.sourceStatus === "cited"
					? "原回答有明确引用；公司事实仍需核实。"
					: "没有可核验最终引用；正面和负面说法都不能当已证实事实。",
			),
			refs(r.evidenceIds),
			...strings(r.sourceUrls).map((u) => link(u)),
		]),
		...reportFollowup(p).flatMap((line) => [
			paragraph(line.title, true),
			paragraph(line.detail),
			refs(line.evidenceIds),
			...line.urls.map((url) => link(url)),
		]),
		paragraph("三、官网怎么改", true),
		paragraph(websiteScoreGuide.formula),
		paragraph(
			a?.websiteAudit?.result.score == null
				? "没有可评分的官网证据，不按零分补齐。"
				: websiteScoreBreakdown(a.websiteAudit.result.checks),
		),
		auditImage,
		paragraph("截图来自当时保存页面的受控渲染；代码与抓取规则问题不能只靠图片判断，请看对应源证据。"),
		...(a?.websiteAudit
			? a.websiteAudit.result.checks.flatMap((c) => [
					paragraph(websiteCheckLanguage[c.id]?.label ?? c.label, true),
					paragraph(websiteCheckLanguage[c.id]?.meaning),
					paragraph(
						`观察：${c.detail}\n定位：${c.selector ?? websiteGuidance[c.id]?.selector ?? "历史未记录"}\n负责人：${websiteCheckLanguage[c.id]?.owner ?? "网站负责人"}\n改法：${c.status === "pass" ? "本项已通过，保持现状，无需重复整改" : (c.recommendation ?? websiteGuidance[c.id]?.recommendation ?? "先核对证据")}\n验收：${c.verification ?? websiteGuidance[c.id]?.verification ?? "修改后重新检查"}`,
					),
					...(a.websiteAudit?.result.evidence
						?.filter((s) => c.evidenceIds?.includes(s.id))
						.flatMap((s) => [link(s.url), paragraph(s.excerpt ?? s.error ?? "无正文摘录；完整文件按项目权限查看")]) ??
						[]),
				])
			: [paragraph("未提供官网或本报告没有官网审计证据，不能推断技术问题。")]),
		paragraph("四、文章用途与发布计划", true),
		...(p.articles?.length
			? p.articles.flatMap((article) => {
					const plan = article.publication_plan as Record<string, unknown> | null;
					return [
						paragraph(article.title, true),
						paragraph(`解决的问题：${article.recommendation_title}`),
						paragraph(
							`回答的监测问题：${articleQuestions(article.target_prompt_ids, p.batch.config).join("；") || "历史文章未保存关联问题，需确认"}`,
						),
						paragraph(
							plan
								? `用途：${plan.purpose}\n目标读者：${plan.audience}\n对应缺口：${plan.problem}`
								: "历史文章未保存发布计划，需补充或重新生成",
						),
						...(plan ? contentStrategySummary(plan.contentStrategy).map((line) => paragraph(line)) : []),
						...rows(plan?.channels).map((c) =>
							paragraph(
								`建议渠道（${channelBasis(c.basis)}，不是已发布）：${c.platform} / ${c.placement}\n选择理由：${c.reason}\n调整方式：${c.adaptation}\n发布前需确认：${c.prerequisite}`,
							),
						),
						...rows(plan?.channels).map((c) => refs(c.evidenceIds)),
						...strings(plan?.acceptance).map((s) => paragraph(`验收：${s}`)),
						article.published_url
							? link(article.published_url, "实际登记的发布地址")
							: paragraph("尚未填写实际发布地址；不能认为已上线或已被引用"),
						refs(article.evidence_ids),
					];
				})
			: [paragraph("冻结报告时没有可交付文章。只有内容类建议适合写文章，技术和采集故障应另行处理。")]),
		paragraph("五、数字含义、公式和分母", true),
		paragraph(aggregationExplanation),
		...Object.entries(metricGuide).flatMap(([key, g]) => [
			paragraph(
				`${g.label}：${
					key === "medianRecommendationRank"
						? (p.batch.metrics.overall.medianRecommendationRank ?? "无明确推荐名次")
						: key === "sourceCoverage"
							? Object.entries(p.batch.metrics.perPlatform)
									.map(([id, m]) => `${evidencePlatformLabel(id)} ${percent(m.sourceCoverage)}`)
									.join("；")
							: percent(p.batch.metrics.overall[key as keyof typeof p.batch.metrics.overall])
				}`,
				true,
			),
			paragraph(g.meaning),
			paragraph(g.formula),
			paragraph(g.caution),
		]),
		...(guide?.platformCounts ?? []).map((r) =>
			paragraph(
				`${evidencePlatformLabel(r.platform)}：采集覆盖 ${r.answered}/${r.planned}；解析覆盖 ${r.parsed}/${r.answered}；问题覆盖 ${r.eligibleQuestions}/${r.plannedQuestions}。`,
			),
		),
		...(guide?.calculationRows ?? []).flatMap((r) => [
			paragraph(
				`${r.question}（${r.named ? "点名" : "不点名"}，${evidencePlatformLabel(r.platform)}）：${r.mentions ?? "未知"} 次提及 / ${r.valid} 个可判断回答；首位 ${r.first ?? "未知"} 次；监测品牌份额 ${percent(r.share)}（${r.mentions ?? "未知"}/${r.monitoredMentions ?? "未知"} 次监测品牌提及）；${r.reason}`,
			),
			refs(r.evidenceIds),
		]),
		paragraph("六、证据目录（点击跳转原文）", true),
		refs(entries.map((entry) => entry.id)),
		...entries.flatMap((entry) => {
			const capture = p.batch.captures?.find((r) => r.captureId === entry.id);
			const web = a?.webPages?.find((r) => r.id === entry.id);
			const extra = a?.supplementalEvidence?.find((r) => r.id === entry.id);
			const content = [
				`<w:p><w:bookmarkStart w:id="${entry.n}" w:name="evidence_${entry.n}"/><w:r><w:t>[${entry.n}] ${xml(entryLabel(entry))}</w:t></w:r><w:bookmarkEnd w:id="${entry.n}"/></w:p>`,
				paragraph(`${entry.platformLabel ?? "网页"} · ${readerDate(entry.capturedAt)}`),
			];
			if (capture) {
				content.push(
					paragraph("AI 回答原文（其中评价不是已核实事实）", true),
					paragraph(capture.answerText || capture.failureMessage || "没有回答正文"),
					paragraph("最终答案明确引用的页面", true),
				);
				content.push(...capture.sources.filter((s) => s.isCitation).map((s) => link(s.url, sourceLabel(s))));
				if (!capture.sources.some((s) => s.isCitation))
					content.push(paragraph("未保存可核验的最终引用；不把搜索记录当引用"));
				content.push(
					paragraph("仅搜索或浏览过的页面（不算引用）", true),
					...capture.sources.filter((s) => !s.isCitation).map((s) => link(s.url, sourceLabel(s))),
				);
			} else if (extra) {
				content.push(
					paragraph("补充历史证据；研究搜索不参与品牌指标"),
					paragraph(extra.content),
					...extra.sourceUrls.map((u) => link(u)),
				);
				for (const c of extra.audit?.checks ?? [])
					content.push(paragraph(`${c.label}：${c.detail}`), paragraph(c.recommendation ?? "先核对源证据"));
			} else if (web) content.push(link(web.url), paragraph(web.content));
			else if (entry.url) content.push(link(entry.url));
			else content.push(paragraph("官网检查请查看本报告对应章节；其他历史证据缺少正文时，不能补写为已核实事实。"));
			return content;
		}),
		paragraph("阅读边界", true),
		...strings(narrative.limitations).map((s) => paragraph(readerText(s))),
		paragraph("通过服务商接口测试，不等同于手机应用；一次检测不代表稳定排名、市场份额或客户满意度。"),
	].join("");
	return { body, relationships: relationships.join("") };
}
