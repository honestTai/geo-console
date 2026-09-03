import { IconSettings } from "@tabler/icons-react";
import { Alert, Skeleton, Spin, Statistic } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../access";
import { api } from "../api";
import { useDelayedLoading } from "../hooks/useDelayedLoading";
import {
	type BatchSummary,
	batchKindLabel,
	type Project,
	shortDate,
	type Task,
	type TrendResponse,
} from "../types";
import { Empty, percentage, SectionTitle } from "../ui/primitives";
import { LineTrendChart, MentionBarChart, overallMetric, overallPercent, perPlatformMention } from "./charts";
import { Page } from "./Page";
import { ScopeEditor } from "./ScopeEditor";

export function OverviewKpis({ trends, tasks }: { trends: TrendResponse; tasks: Task[] }) {
	const latest = trends.comparable.at(-1);
	const baseline = trends.comparable.length > 1 ? trends.comparable[0] : null;
	if (!latest) return null;
	const openTasks = tasks.filter((task) => task.status === "todo" || task.status === "in_progress").length;
	const draftPending = tasks.some(
		(task) => task.draft_content && task.status !== "published" && task.status !== "verified" && task.status !== "done",
	);
	const deltaPoints = (key: string): number | null => {
		if (!baseline) return null;
		const before = overallMetric(baseline, key);
		const after = overallMetric(latest, key);
		return before == null || after == null ? null : (after - before) * 100;
	};
	const evidenceCount = latest.metrics.validSamples + latest.metrics.failedSamples;
	const evidenceDelta = baseline
		? evidenceCount - (baseline.metrics.validSamples + baseline.metrics.failedSamples)
		: null;
	// 没有可比基线时不在每张卡片上重复“首个基线”，只在网格下方说明一次数据来源
	const deltaChip = (value: number | null, unit: string) =>
		value == null ? null : value === 0 ? (
			<span className="kpi-delta">与基线持平</span>
		) : (
			<span className={`kpi-delta ${value >= 0 ? "up" : "down"}`}>
				较基线 {value >= 0 ? "+" : ""}
				{value.toFixed(1)}
				{unit}
			</span>
		);
	const batchLabel = (item: TrendResponse["comparable"][number]) =>
		`${batchKindLabel(item.kind as BatchSummary["kind"])} · ${shortDate(item.createdAt)}`;
	return (
		<>
			<div className="kpi-grid">
				<div className="kpi-card">
					<Statistic title="品牌提及率" value={percentage(overallMetric(latest, "brandMentionRate"))} />
					{deltaChip(deltaPoints("brandMentionRate"), " 百分点")}
				</div>
				<div className="kpi-card">
					<Statistic title="首位推荐率" value={percentage(overallMetric(latest, "firstRecommendationRate"))} />
					{deltaChip(deltaPoints("firstRecommendationRate"), " 百分点")}
				</div>
				<div className="kpi-card">
					<Statistic title="官网引用率" value={percentage(overallMetric(latest, "citationRate"))} />
					{deltaChip(deltaPoints("citationRate"), " 百分点")}
				</div>
				<div className="kpi-card">
					<Statistic title="证据存证" value={evidenceCount} suffix=" 条" />
					{deltaChip(evidenceDelta, " 条")}
				</div>
				<div className="kpi-card">
					<Statistic title="整改任务" value={openTasks} suffix=" 待审批" />
					<span className="kpi-delta">
						{draftPending ? "HRouter Agent 草稿待审" : openTasks > 0 ? "待人工处理" : "全部已验收"}
					</span>
				</div>
			</div>
			<p className="kpi-caption muted">
				{baseline
					? `数值来自「${batchLabel(latest)}」，变化相对「${batchLabel(baseline)}」计算。`
					: `数值来自「${batchLabel(latest)}」；完成一次同条件复测后显示较基线的变化。`}
			</p>
		</>
	);
}

export function OverviewTrendPanel({
	latest,
	trends,
	loading,
}: {
	latest: BatchSummary | undefined;
	trends: TrendResponse | null;
	loading: boolean;
}) {
	let content: ReactNode;
	if (!latest) {
		content = <Empty title="还没有监测批次" detail="建立首个基线后，这里会显示关键指标随批次的变化趋势。" />;
	} else if (loading) {
		content = (
			<div className="chart-loading">
				<Spin size="small" />
				<span>正在加载趋势</span>
			</div>
		);
	} else if (!trends || trends.comparable.length === 0) {
		content = <Empty compact title="暂无可比较的批次数据" detail="批次完成后自动出现。" />;
	} else {
		const latestComparable = trends.comparable.at(-1);
		content = (
			<>
				<SectionTitle title="指标趋势" description="同配置批次按时间排列；复测与基线条件一致时才可比较。" />
				{trends.comparable.length < 2 ? (
					<Alert type="info" showIcon title="当前只有一个同配置批次；完成一次“同条件复测”后显示趋势曲线。" />
				) : (
					<LineTrendChart
						labels={trends.comparable.map((item) => ({ id: item.id, label: shortDate(item.createdAt) }))}
						series={[
							{
								label: "品牌提及率",
								color: "var(--brand)",
								values: trends.comparable.map((item) => overallPercent(item, "brandMentionRate")),
							},
							{
								label: "首位推荐率",
								color: "var(--ink-3)",
								values: trends.comparable.map((item) => overallPercent(item, "firstRecommendationRate")),
							},
							{
								label: "官网引用率",
								color: "var(--ink-4)",
								values: trends.comparable.map((item) => overallPercent(item, "citationRate")),
							},
						]}
					/>
				)}
				{latestComparable ? (
					<>
						<SectionTitle
							title="平台覆盖"
							description={`「${batchKindLabel(latestComparable.kind as BatchSummary["kind"])} · ${shortDate(latestComparable.createdAt)}」各平台的品牌提及率。`}
						/>
						<MentionBarChart
							items={perPlatformMention(latestComparable.metrics)}
							note="失败平台不进入品牌率分母；未开放来源的平台引用率记为不可用。"
						/>
					</>
				) : null}
			</>
		);
	}
	return <div className="overview-trends">{content}</div>;
}

export function Overview({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const latest = project.batches[0];
	const latestId = latest?.id;
	const [editingScope, setEditingScope] = useState(false);
	const [trends, setTrends] = useState<TrendResponse | null>(null);
	const [trendsLoading, setTrendsLoading] = useState(false);
	// 切换批次时先保留旧数据，超过延迟阈值才换成骨架屏；首次加载没有旧数据可留，立即显示加载态
	const delayedLoading = useDelayedLoading(trendsLoading);
	const showTrendsLoading = trendsLoading && (!trends || delayedLoading);
	useEffect(() => {
		if (!latestId) {
			setTrends(null);
			return;
		}
		let current = true;
		setTrendsLoading(true);
		api<TrendResponse>(`/api/projects/${project.id}/trends/${latestId}`)
			.then((result) => {
				if (current) setTrends(result);
			})
			.catch(() => {
				if (current) setTrends(null);
			})
			.finally(() => {
				if (current) setTrendsLoading(false);
			});
		return () => {
			current = false;
		};
	}, [project.id, latestId]);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="项目总览"
			title="可见度总览"
			description="最新批次的核心指标、趋势与平台覆盖。"
			extra={
				<Button
					permission="project.onboard"
					variant="secondary"
					icon={<IconSettings size={16} />}
					onClick={() => setEditingScope(true)}
				>
					编辑监测范围
				</Button>
			}
		>
			{showTrendsLoading ? (
				<div className="kpi-grid" aria-hidden="true">
					{["skeleton-a", "skeleton-b", "skeleton-c", "skeleton-d", "skeleton-e"].map((key) => (
						<div className="kpi-card" key={key}>
							<Skeleton active title={false} paragraph={{ rows: 2, width: ["45%", "70%"] }} />
						</div>
					))}
				</div>
			) : trends ? (
				<OverviewKpis trends={trends} tasks={project.tasks} />
			) : null}
			<OverviewTrendPanel latest={latest} trends={trends} loading={showTrendsLoading} />
			{editingScope && <ScopeEditor project={project} onClose={() => setEditingScope(false)} refresh={refresh} />}
		</Page>
	);
}
