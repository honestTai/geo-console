import { aggregationExplanation, type MeasurementExplanation as Explanation, metricGuide } from "@geo/metrics";
import { Alert, Button, Drawer, Table, type TableProps } from "antd";
import { useState } from "react";
import { providerLabel } from "../types";
import { MetricLabel } from "../ui/MetricLabel";
import { useWorkspaceNavigation } from "../ui/navigation";
import { percentage, SectionTitle } from "../ui/primitives";

export function MeasurementExplanation({
	explanation,
	batchId,
}: {
	explanation?: Explanation | null;
	batchId: string;
}) {
	const [open, setOpen] = useState(false);
	const { openEvidence } = useWorkspaceNavigation();
	const columns: TableProps<Explanation["calculationRows"][number]>["columns"] = [
		{
			title: "平台 / 问题",
			width: 320,
			render: (_, r) => (
				<>
					<small>
						{providerLabel(r.platform)} · {r.named ? "点名问公司" : "不点名提问"}
					</small>
					<p>{r.question}</p>
				</>
			),
		},
		{
			title: <MetricLabel metric="brandMentionRate" />,
			render: (_, r) => `${r.mentions ?? "未知"} 次提及 / ${r.valid} 个可判断回答`,
		},
		{
			title: <MetricLabel metric="firstRecommendationRate" />,
			render: (_, r) => `${r.first ?? "未知"} 次首位 / ${r.valid} 个可判断回答`,
		},
		{
			title: <MetricLabel metric="monitoredBrandShare" />,
			render: (_, r) =>
				`${percentage(r.share)} · ${r.mentions ?? "未知"} / ${r.monitoredMentions ?? "未知"} 次监测品牌提及`,
		},
		{
			title: "纳入情况 / 原始回答",
			render: (_, r) => (
				<>
					{r.reason}
					<div>
						{r.evidenceIds.map((id, i) => (
							<Button key={id} size="small" type="link" onClick={() => openEvidence(id, batchId)}>
								回答 {i + 1}
							</Button>
						))}
					</div>
				</>
			),
		},
	];
	return (
		<section className="measurement-explanation">
			<SectionTitle
				title="数字怎么算，哪些问题算了？"
				description="把检测完成度和企业表现分开；失败不是差评，搜索到不等于引用。"
				extra={<Button onClick={() => setOpen(true)}>查看公式、分母与原始回答</Button>}
			/>
			{explanation ? (
				<>
					<p>{explanation.scope}</p>
					<p>
						<b>
							{explanation.counts.planned} 次计划 → {explanation.counts.answered} 次取得回答 →{" "}
							{explanation.counts.parsed} 次可用于品牌判断
						</b>
					</p>
					<Alert type="info" showIcon title={`${explanation.status}。${explanation.limitation}`} />
					<Table
						size="small"
						rowKey="label"
						pagination={false}
						dataSource={explanation.segments}
						columns={[
							{ title: "问题分组", dataIndex: "label" },
							{ title: "有效 / 计划问题", render: (_, s) => `${s.eligibleQuestions} / ${s.plannedQuestions}` },
							{ title: <MetricLabel metric="brandMentionRate" />, render: (_, s) => percentage(s.mentionRate) },
							{
								title: "核对次数（不替代等权总分）",
								render: (_, s) => `${s.mentionAnswers} 次提及 / ${s.validAnswers} 个可判断回答`,
							},
						]}
					/>
					<p>
						{explanation.sources.withSearchSources} 个回答有搜索来源；{explanation.sources.withFinalCitations}{" "}
						个回答有明确最终引用，共 {explanation.sources.citationLinks} 条引用；{explanation.sources.unavailable}{" "}
						个回答的来源不可观察。
					</p>
				</>
			) : (
				<p>尚未生成可靠的指标说明。请等待解析完成；不显示模拟分数。</p>
			)}
			<Drawer open={open} onClose={() => setOpen(false)} title="指标说明与计算依据" size="min(1180px, 95vw)">
				<p>{aggregationExplanation}</p>
				{Object.entries(metricGuide).map(([key, g]) => (
					<section key={key}>
						<h3>{g.label}</h3>
						<p>{g.meaning}</p>
						<p>
							<b>公式：</b>
							{g.formula}
						</p>
						<p>{g.caution}</p>
					</section>
				))}
				{explanation && (
					<>
						<h3>完成度分子 / 分母</h3>
						<Table
							size="small"
							pagination={false}
							rowKey="platform"
							dataSource={explanation.platformCounts}
							columns={[
								{ title: "平台", render: (_, r) => providerLabel(r.platform) },
								{ title: "采集覆盖", render: (_, r) => `${r.answered} / ${r.planned}` },
								{ title: "解析覆盖", render: (_, r) => `${r.parsed} / ${r.answered}` },
								{ title: "问题覆盖", render: (_, r) => `${r.eligibleQuestions} / ${r.plannedQuestions}` },
							]}
						/>
						<h3>逐问题计算及证据</h3>
						<Table
							size="small"
							rowKey={(r) => `${r.platform}:${r.promptId}`}
							dataSource={explanation.calculationRows}
							columns={columns}
							pagination={{ pageSize: 10, showSizeChanger: false }}
							scroll={{ x: 950 }}
						/>
						<h3>失败记录与对应处理办法</h3>
						{explanation.failures.map((f) => (
							<article key={f.captureId}>
								<p>
									{f.question}：{f.reason}
								</p>
								<p>
									{f.action}
									<Button type="link" onClick={() => openEvidence(f.captureId, batchId)}>
										查看失败记录
									</Button>
								</p>
							</article>
						))}
					</>
				)}
			</Drawer>
		</section>
	);
}
