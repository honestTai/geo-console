import type { ReactNode } from "react";
import {
	type Batch,
	type BatchSummary,
	batchKindLabel,
	type PlatformMetrics,
	providerLabel,
	providerShortLabel,
	shortDate,
	type TrendResponse,
} from "../types";
import { date, Notice, percentage } from "../ui/primitives";

/** 图表卡外壳：可选标题 + 可选图例 + 可选脚注，收敛三处重复的 chart-card markup。页面已有小节标题时不传 title，避免同名两次。 */
function ChartCard({
	title,
	legend,
	note,
	children,
}: {
	title?: string;
	legend?: ChartSeries[];
	note?: string;
	children: ReactNode;
}) {
	return (
		<div className="chart-card">
			{title || legend ? (
				<div className="chart-head">
					{title ? <h4>{title}</h4> : null}
					{legend ? <ChartLegend series={legend} /> : null}
				</div>
			) : null}
			{children}
			{note ? <p className="chart-note">{note}</p> : null}
		</div>
	);
}

/** 条形图行：标签 + 轨道 + 数值，MentionBarChart 与 ComparisonDeltaChart 复用。 */
function BarRow({
	label,
	track,
	value,
	valueClass,
}: {
	label: string;
	track: ReactNode;
	value: ReactNode;
	valueClass?: string;
}) {
	return (
		<div className="chart-bar-row">
			<span className="chart-bar-label" title={label}>
				{label}
			</span>
			{track}
			<span className={`chart-bar-value${valueClass ? ` ${valueClass}` : ""}`}>{value}</span>
		</div>
	);
}

const overallTrendKeys = [
	{ key: "brandMentionRate", label: "提及" },
	{ key: "firstRecommendationRate", label: "首位" },
	{ key: "citationRate", label: "官网引用" },
] as const;

export function TrendChart({ trends }: { trends: TrendResponse }) {
	const anchor = trends.comparable.find((item) => item.id === trends.anchorBatchId) ?? trends.comparable.at(-1);
	return (
		<div className="trend-section">
			<div className="section-head compact">
				<div>
					<h3>同配置趋势</h3>
					<p>只纳入冻结配置哈希一致的批次，配置变化不会混入趋势。</p>
				</div>
				<span>{trends.comparable.length} 个可比批次</span>
			</div>
			{trends.comparable.length < 2 ? (
				<p className="muted trend-empty">当前只有一个同配置批次；完成一次“按此条件复测”后显示前后趋势。</p>
			) : (
				<div className="trend-table">
					{trends.comparable.map((item) => (
						<div className="trend-row" key={item.id}>
							<time>{date(item.createdAt)}</time>
							{overallTrendKeys.map(({ key, label }) => (
								<div key={key}>
									<MetricLabel metric={key} label={label} />
									<i style={{ width: percentage(item.metrics.overall[key] as number | null) }} />
									<b>{percentage(item.metrics.overall[key] as number | null)}</b>
								</div>
							))}
						</div>
					))}
				</div>
			)}
			<div className="trend-charts">
				<MentionBarChart
					title="各批次品牌提及率"
					items={trends.comparable.map((item) => ({
						key: item.id,
						label: `${batchKindLabel(item.kind as BatchSummary["kind"])} · ${shortDate(item.createdAt)}`,
						value: overallMetric(item, "brandMentionRate"),
					}))}
				/>
				{anchor ? (
					<MentionBarChart
						title="各平台品牌提及率"
						items={perPlatformMention(anchor.metrics)}
						note="取自当前选中批次；失败平台不进入品牌率分母。"
					/>
				) : null}
			</div>
		</div>
	);
}

export type ChartSeries = { label: string; color: string; values: Array<number | null> };
export type ChartLabel = { id: string; label: string };

export const overallMetric = (item: TrendResponse["comparable"][number], key: string): number | null => {
	const value = item.metrics.overall[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const overallPercent = (item: TrendResponse["comparable"][number], key: string): number | null => {
	const value = overallMetric(item, key);
	return value == null ? null : value * 100;
};

/** 没有任何成功回答的平台不进入品牌率分母，图表上显示“不可用”而不是 0%。 */
export const platformUnavailable = (metrics: PlatformMetrics | undefined): boolean =>
	!metrics || metrics.answeredCaptures === 0 || metrics.status === "unavailable";

export const perPlatformMention = (metrics: Batch["metrics"]): Array<{ label: string; value: number | null }> =>
	Object.entries(metrics.perPlatform).map(([platform, item]) => ({
		label: providerShortLabel(platform),
		value: platformUnavailable(item) ? null : item.brandMentionRate,
	}));

export function ChartLegend({ series }: { series: ChartSeries[] }) {
	return (
		<div className="chart-legend">
			{series.map((item) => (
				<span key={item.label}>
					<i style={{ background: item.color }} />
					{item.label}
				</span>
			))}
		</div>
	);
}

export function LineTrendChart({
	series,
	labels,
	title,
}: {
	series: ChartSeries[];
	labels: ChartLabel[];
	title?: string;
}) {
	const width = 1000;
	const height = 260;
	const padLeft = 46;
	const padRight = 16;
	const padTop = 16;
	const padBottom = 30;
	const innerWidth = width - padLeft - padRight;
	const innerHeight = height - padTop - padBottom;
	const xAt = (index: number) => (labels.length > 1 ? padLeft + (innerWidth * index) / (labels.length - 1) : width / 2);
	const yAt = (value: number) => padTop + innerHeight * (1 - Math.min(100, Math.max(0, value)) / 100);
	return (
		<ChartCard title={title} legend={series}>
			<svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="关键指标趋势图">
				{[0, 25, 50, 75, 100].map((tick) => (
					<g key={tick}>
						<line
							x1={padLeft}
							y1={yAt(tick)}
							x2={width - padRight}
							y2={yAt(tick)}
							stroke="var(--line)"
							strokeWidth="1"
						/>
						<text x={padLeft - 8} y={yAt(tick) + 4} textAnchor="end">
							{tick}%
						</text>
					</g>
				))}
				{labels.map((item, index) => (
					<text key={item.id} x={xAt(index)} y={height - 8} textAnchor="middle">
						{item.label}
					</text>
				))}
				{series.map((item) => {
					const segments: string[] = [];
					let current = "";
					item.values.forEach((value, index) => {
						if (value == null) {
							if (current) segments.push(current);
							current = "";
							return;
						}
						current += `${current ? " L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`;
					});
					if (current) segments.push(current);
					return (
						<g key={item.label}>
							{segments.map((d) => (
								<path
									key={d}
									d={d}
									fill="none"
									stroke={item.color}
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							))}
							{item.values.map((value, index) =>
								value == null ? null : (
									<circle
										key={`${item.label}-${labels[index]?.id ?? value}`}
										cx={xAt(index)}
										cy={yAt(value)}
										r="3.5"
										fill="var(--surface)"
										stroke={item.color}
										strokeWidth="2"
									/>
								),
							)}
						</g>
					);
				})}
			</svg>
		</ChartCard>
	);
}

export function MentionBarChart({
	title,
	items,
	note,
}: {
	title?: string;
	items: Array<{ key?: string; label: string; value: number | null }>;
	note?: string;
}) {
	if (!items.length) return null;
	return (
		<ChartCard title={title} note={note}>
			<div className="chart-bars">
				{items.map((item) => (
					<BarRow
						key={item.key ?? item.label}
						label={item.label}
						value={item.value == null ? "不可用" : percentage(item.value)}
						valueClass={item.value == null ? "unavailable" : undefined}
						track={
							<span className="chart-bar-track">
								{item.value == null ? null : (
									<i className="chart-bar-fill" style={{ width: `${Math.round(item.value * 100)}%` }} />
								)}
							</span>
						}
					/>
				))}
			</div>
		</ChartCard>
	);
}

export function ComparisonDeltaChart({
	current,
	baseline,
	title = "基线 → 复测变化（百分点）",
}: {
	current: Batch;
	baseline: Batch;
	title?: string;
}) {
	const metrics = [
		{ key: "brandMentionRate", label: "品牌提及率" },
		{ key: "firstRecommendationRate", label: "首位推荐率" },
		{ key: "citationRate", label: "官网引用率" },
	] as const;
	const rows = current.config.platforms.flatMap((platform) =>
		metrics.map((metric) => {
			const beforeMetrics = baseline.metrics.perPlatform[platform];
			const afterMetrics = current.metrics.perPlatform[platform];
			const paired = current.pairedComparison?.find(
				(p) => p.provider_id === platform && p.metric === metric.key,
			)?.result;
			const before =
				platformUnavailable(beforeMetrics) || paired?.status !== "ready" ? null : (paired?.previous ?? null);
			const after = platformUnavailable(afterMetrics) || paired?.status !== "ready" ? null : (paired?.current ?? null);
			return {
				label: `${providerShortLabel(platform)} · ${metric.label}`,
				value: before == null || after == null ? null : (after - before) * 100,
			};
		}),
	);
	if (!rows.some((row) => row.value != null)) return null;
	return (
		<ChartCard
			title={title}
			note="正值表示复测高于基线；使用共同有效问题的配对点估计；是否显著以配对区间和正式告警为准。"
		>
			<div className="chart-bars">
				{rows.map((row) => {
					const widthPercent = Math.min(50, Math.abs(row.value ?? 0) / 2);
					return (
						<BarRow
							key={row.label}
							label={row.label}
							value={row.value == null ? "-" : `${row.value >= 0 ? "+" : ""}${row.value.toFixed(1)}`}
							valueClass={row.value == null ? undefined : row.value >= 0 ? "positive" : "negative"}
							track={
								<span className="chart-delta-track">
									<i className="chart-delta-zero" />
									{row.value == null ? null : (
										<i
											className={`chart-delta-fill ${row.value >= 0 ? "pos" : "neg"}`}
											style={
												row.value >= 0
													? { left: "50%", width: `${widthPercent}%` }
													: { right: "50%", width: `${widthPercent}%` }
											}
										/>
									)}
								</span>
							}
						/>
					);
				})}
			</div>
		</ChartCard>
	);
}

function MetricCard({ platform, metrics }: { platform: string; metrics: PlatformMetrics }) {
	const unavailable = platformUnavailable(metrics);
	const rows: Array<{ label: string; value: string }> = [
		{ label: "首位推荐率", value: unavailable ? "-" : percentage(metrics.firstRecommendationRate) },
		{ label: "官网引用率", value: unavailable ? "-" : percentage(metrics.citationRate) },
		{ label: "监测品牌出现份额", value: unavailable ? "-" : percentage(metrics.monitoredBrandShare) },
		{ label: "重复回答一致率", value: unavailable ? "-" : percentage(metrics.pairwiseAgreement) },
		{ label: "明确推荐名次中位数", value: unavailable ? "-" : (metrics.medianRecommendationRank?.toFixed(1) ?? "-") },
		{ label: "采集覆盖率", value: percentage(metrics.captureCoverage) },
	];
	return (
		<article className={unavailable ? "metric-card unavailable" : "metric-card"}>
			<header>
				<strong>{providerLabel(platform)}</strong>
				<span className="metric-badge">
					{metrics.answeredCaptures}/{metrics.totalCaptures} 有回答
				</span>
			</header>
			<div className="metric-hero">
				<b>{unavailable ? "不可用" : percentage(metrics.brandMentionRate)}</b>
				<span>
					{unavailable ? (
						metrics.answeredCaptures > 0 ? (
							"已有回答，但语义解析或问题覆盖不足，暂不展示品牌率"
						) : (
							"该平台本批次没有成功回答，不进入品牌率分母"
						)
					) : (
						<MetricLabel metric="brandMentionRate" />
					)}
				</span>
			</div>
			<dl>
				{rows.map((row) => (
					<div key={row.label}>
						<dt>
							<MetricLabel label={row.label} />
						</dt>
						<dd>{row.value}</dd>
					</div>
				))}
			</dl>
		</article>
	);
}

export function BatchMetrics({ batch }: { batch: Batch }) {
	const sampleItems: Array<{ label: string; value: ReactNode }> = [
		{ label: "成功采集的回答（不等于已解析）", value: batch.metrics.validSamples },
		{ label: "未通过采集检查的记录（不算品牌零分）", value: batch.metrics.failedSamples },
		{ label: "计划采集次数", value: batch.metrics.expectedSamples },
		{
			label: "条件",
			value: `${batch.config.prompts.length}题 × ${batch.config.platforms.length}平台 × ${batch.config.repeats}次`,
		},
	];
	return (
		<div className="metrics-area">
			<div className="sample-line">
				{sampleItems.map((item) => (
					<span key={item.label}>
						{item.label} <b>{item.value}</b>
					</span>
				))}
			</div>
			<div className="metric-grid">
				{Object.entries(batch.metrics.perPlatform).map(([platform, metrics]) => (
					<MetricCard key={platform} platform={platform} metrics={metrics} />
				))}
			</div>
			<Notice message="平台指标分别计算；总览只做平台等权汇总。AI答案具有随机性，本系统报告采样变化，不承诺固定排名。" />
		</div>
	);
}

import { MetricLabel } from "../ui/MetricLabel";
