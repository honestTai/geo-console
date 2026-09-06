import type { AnalysisEvidenceSpan, AnalysisReference, AnswerAnalysisResult, AnswerAnalysisView } from "@geo/evidence";
import { Button, Tag } from "antd";
import { Fragment } from "react";

export const sentimentLabels: Record<string, string> = {
	positive: "正面",
	neutral: "中性",
	negative: "负面",
	mixed: "褒贬并存",
	unclear: "态度不明",
};
export const stanceLabels: Record<string, string> = {
	explicit: "明确推荐",
	implicit: "隐含推荐",
	conditional: "有条件推荐",
	none: "未表达推荐",
	against: "反对推荐",
	mixed: "立场混合",
	unclear: "立场不明",
};
const kindLabels: Record<string, string> = {
	background: "背景",
	recommendation: "推荐",
	comparison: "比较",
	explanation: "说明",
	limitation: "限制",
	other: "其他",
};
const typeLabels: Record<string, string> = {
	recommendation: "推荐型回答",
	comparison: "比较型回答",
	informational: "知识说明型回答",
	mixed: "混合型回答",
	other: "其他类型回答",
};
type OnEvidence = (span: AnalysisEvidenceSpan) => void;

function References({
	refs,
	spans,
	onEvidence,
}: {
	refs: AnalysisReference[];
	spans: AnalysisEvidenceSpan[];
	onEvidence: OnEvidence;
}) {
	return (
		<span className="aa-references">
			{refs.map((ref, index) => {
				const span = spans.find((item) => item.segmentId === ref.segmentId && item.quote === ref.quote);
				return span ? (
					<Button
						key={`${ref.segmentId}:${ref.quote}`}
						type="link"
						size="small"
						title={ref.quote}
						onClick={() => onEvidence(span)}
					>
						查看原文 {index + 1}
					</Button>
				) : null;
			})}
		</span>
	);
}

export function AnswerAnalysisContent({
	result,
	brands,
	onEvidence,
}: {
	result: AnswerAnalysisResult;
	brands: AnswerAnalysisView["brands"];
	onEvidence: OnEvidence;
}) {
	const { analysis, evidenceSpans, coverage } = result;
	const name = (id: string) => brands.find((brand) => brand.id === id)?.name ?? "未知监测品牌";
	const refs = (items: AnalysisReference[]) => (
		<References refs={items} spans={evidenceSpans} onEvidence={onEvidence} />
	);
	return (
		<div className="aa-content">
			<div className="aa-overview">
				<div className="aa-tags">
					<Tag color="default">{typeLabels[analysis.answerType]}</Tag>
					<Tag color="default">
						原文分段覆盖 {coverage.analyzedSegments}/{coverage.totalSegments}
					</Tag>
				</div>
				<h4>这段回答在说什么</h4>
				<p>
					{analysis.summary.text}
					{refs(analysis.summary.evidence)}
				</p>
				<ul className="aa-points">
					{analysis.keyPoints.map((point) => (
						<li key={JSON.stringify(point)}>
							{point.text}
							{refs(point.evidence)}
						</li>
					))}
				</ul>
			</div>
			<section className="aa-section" aria-label="品牌态度与评价维度">
				<h4>如何评价各品牌</h4>
				{!analysis.brands.length && (
					<p className="muted">这份解读没有可展示的监测品牌评价；请结合分段覆盖与待核对提示，不将其推断为负面评价。</p>
				)}
				<div className="aa-brand-grid">
					{analysis.brands.map((brand) => (
						<article className="aa-brand" key={brand.brandId}>
							<div className="aa-brand-head">
								<strong>{name(brand.brandId)}</strong>
								<div className="aa-tags">
									<Tag color="default">{sentimentLabels[brand.sentiment]}</Tag>
									<Tag color="default">{stanceLabels[brand.stance]}</Tag>
								</div>
							</div>
							<p>
								{brand.summary.text}
								{refs(brand.summary.evidence)}
							</p>
							{brand.aspects.length > 0 ? (
								<dl className="aa-aspects">
									{brand.aspects.map((aspect) => (
										<Fragment key={JSON.stringify(aspect)}>
											<dt>
												{aspect.aspect}
												<Tag color="default">{sentimentLabels[aspect.sentiment]}</Tag>
											</dt>
											<dd>
												{aspect.assessment}
												{refs(aspect.evidence)}
											</dd>
										</Fragment>
									))}
								</dl>
							) : (
								<p className="muted">本次解读未提取到具体维度评价。</p>
							)}
							{brand.recommendations.length > 0 && (
								<div className="aa-reasons">
									<h5>推荐 / 排除理由与条件</h5>
									{brand.recommendations.map((item) => (
										<div className="aa-reason" key={JSON.stringify(item)}>
											<Tag color="default">{stanceLabels[item.stance]}</Tag>
											<p>{item.reason ?? "原文没有明确说明理由。"}</p>
											{item.conditions.length > 0 ? (
												<ul>
													{[...new Set(item.conditions)].map((condition) => (
														<li key={condition}>适用条件：{condition}</li>
													))}
												</ul>
											) : (
												<span className="muted">未明确限定适用条件</span>
											)}
											{refs(item.evidence)}
										</div>
									))}
								</div>
							)}
						</article>
					))}
				</div>
			</section>
			<section className="aa-section" aria-label="品牌比较">
				<h4>回答中的品牌比较</h4>
				{analysis.comparisons.length ? (
					analysis.comparisons.map((comparison) => (
						<article className="aa-comparison" key={JSON.stringify(comparison)}>
							<strong>
								{comparison.brandIds.map(name).join(" / ")} · {comparison.aspect}
							</strong>
							<p>
								{comparison.conclusion}
								{refs(comparison.evidence)}
							</p>
							<span className="muted">
								{comparison.favoredBrandId
									? `此项比较倾向：${name(comparison.favoredBrandId)}（不是综合排名）`
									: "未表达明确偏好，不判定胜出品牌。"}
							</span>
						</article>
					))
				) : (
					<p className="muted">本次解读未提取到监测品牌的直接比较。</p>
				)}
			</section>
			<section className="aa-section" aria-label="全文分段解读">
				<h4>全文分段解读</h4>
				<p className="muted">按原文顺序覆盖整份回答，包括与品牌无关的段落；覆盖只表示结构完整性，不代表分析准确率。</p>
				<ol className="aa-outline">
					{analysis.sections.map((section) => (
						<li key={JSON.stringify(section)}>
							<div className="aa-outline-head">
								<strong>{section.title}</strong>
								<Tag color="default">{kindLabels[section.kind]}</Tag>
								<span className="muted">{section.segmentIds.join(" · ")}</span>
							</div>
							<p>
								{section.summary}
								{refs(section.evidence)}
							</p>
						</li>
					))}
				</ol>
			</section>
			<section className="aa-section" aria-label="限制与歧义">
				<h4>回答明确表达的限制</h4>
				{analysis.limitations.length ? (
					<ul className="aa-points">
						{analysis.limitations.map((item) => (
							<li key={JSON.stringify(item)}>
								{item.text}
								{refs(item.evidence)}
							</li>
						))}
					</ul>
				) : (
					<p className="muted">没有提取到原文明确表达的限制；不表示品牌没有限制。</p>
				)}
				{analysis.ambiguities.length > 0 && (
					<>
						<h5>需要核对的语义歧义</h5>
						<ul>
							{[...new Set(analysis.ambiguities)].map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</>
				)}
			</section>
		</div>
	);
}

export function HighlightedAnswer({
	answer,
	span,
	markRef,
}: {
	answer: string;
	span: AnalysisEvidenceSpan | null;
	markRef?: React.Ref<HTMLElement>;
}) {
	const valid = span && span.start >= 0 && span.end > span.start && answer.slice(span.start, span.end) === span.quote;
	return (
		<pre className="aa-original">
			{valid ? (
				<>
					{answer.slice(0, span.start)}
					<mark ref={markRef}>{answer.slice(span.start, span.end)}</mark>
					{answer.slice(span.end)}
				</>
			) : (
				answer
			)}
		</pre>
	);
}
