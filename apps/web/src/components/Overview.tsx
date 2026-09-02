import { IconSettings } from "@tabler/icons-react";
import { Skeleton, Spin, Statistic } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../access";
import { api } from "../api";
import { type BatchSummary, type Project, shortDate, type Task, type TrendResponse } from "../types";
import { percentage } from "../ui/primitives";
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
	const deltaChip = (value: number | null, unit: string) =>
		value == null ? (
			<span className="kpi-delta">首个基线</span>
		) : value === 0 ? (
			<span className="kpi-delta">与基线持平</span>
		) : (
			<span className={`kpi-delta ${value >= 0 ? "up" : "down"}`}>
				较基线 {value >= 0 ? "+" : ""}
				{value.toFixed(1)}
				{unit}
			</span>
		);
	return (
		<div className="kpi-grid">
			<div className="kpi-card">
				<Statistic title="品牌提及率" value={percentage(overallMetric(latest, "brandMentionRate"))} />
				{deltaChip(deltaPoints("brandMentionRate"), "")}
			</div>
			<div className="kpi-card">
				<Statistic title="首位推荐率" value={percentage(overallMetric(latest, "firstRecommendationRate"))} />
				{deltaChip(deltaPoints("firstRecommendationRate"), "")}
			</div>
			<div className="kpi-card">
				<Statistic title="官网引用率" value={percentage(overallMetric(latest, "citationRate"))} />
				{deltaChip(deltaPoints("citationRate"), "")}
			</div>
			<div className="kpi-card">
				<Statistic title="证据存证" value={evidenceCount} suffix=" 条" />
				{deltaChip(evidenceDelta, " 条")}
			</div>
			<div className="kpi-card">
				<Statistic title="整改任务" value={openTasks} suffix=" 待审批" />
				<span className="kpi-delta">
					{draftPending ? "Pi Agent 草稿待审" : openTasks > 0 ? "待人工处理" : "全部已验收"}
				</span>
			</div>
		</div>
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
		content = <p className="muted trend-empty">建立首个基线后，这里会显示关键指标随批次的变化趋势。</p>;
	} else if (loading) {
		content = (
			<div className="chart-loading">
				<Spin size="small" />
				<span>正在加载趋势</span>
			</div>
		);
	} else if (!trends || trends.comparable.length === 0) {
		content = <p className="muted trend-empty">暂无可比较的批次数据。</p>;
	} else {
		const latestComparable = trends.comparable.at(-1);
		content = (
			<>
				{trends.comparable.length < 2 ? (
					<p className="muted trend-empty">当前只有一个同配置批次；完成一次“同条件复测”后显示趋势曲线。</p>
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
					<MentionBarChart
						title="平台覆盖（最新可比批次品牌提及率）"
						items={perPlatformMention(latestComparable.metrics)}
						note="失败平台不进入品牌率分母；未开放来源的平台引用率记为不可用。"
					/>
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
			title={`${project.name} · 可见度总览`}
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
			{trendsLoading ? (
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
			<OverviewTrendPanel latest={latest} trends={trends} loading={trendsLoading} />
			{editingScope && <ScopeEditor project={project} onClose={() => setEditingScope(false)} refresh={refresh} />}
		</Page>
	);
}
