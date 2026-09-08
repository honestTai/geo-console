import { Alert, Skeleton, Table } from "antd";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { View } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { SectionTitle } from "../ui/primitives";
import "./ContentOperations.css";

const sourceLabels: Record<string, string> = {
	ga4: "GA4 导入",
	form: "表单导入",
	phone: "电话导入",
	manual: "业务台账",
	gsc: "GSC 导入",
};
const metricLabels: Record<string, string> = {
	sessions: "会话数",
	users: "用户数",
	leads: "线索数",
	qualified_leads: "有效线索",
	phone_calls: "电话咨询",
};

type Entry = { key: string; label: string; count: number; view: View; filter: string };
type OperationsData = {
	items: Entry[];
	content: { total: number; published: number } | null;
	attribution: Array<{ source_type: string; metric: string; value: number; last_observed_at: string }>;
	pendingRetests: Array<{ id: string }>;
};
export function OperationsOverview({ projectId }: { projectId: string }) {
	const [items, setItems] = useState<Entry[] | null>(null),
		[data, setData] = useState<OperationsData | null>(null),
		[error, setError] = useState<string | null>(null),
		navigation = useWorkspaceNavigation();
	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		const load = async () => {
			try {
				const result = await api<OperationsData>(`/api/projects/${projectId}/operations`, {
					signal: controller.signal,
				});
				if (active) {
					setItems(result.items);
					setData(result);
					setError(null);
				}
			} catch (e) {
				if (active) setError(e instanceof Error ? e.message : "待办加载失败");
			}
		};
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState !== "hidden") void load();
		}, 15000);
		return () => {
			active = false;
			controller.abort();
			clearInterval(timer);
		};
	}, [projectId]);
	return (
		<section>
			<SectionTitle title="运营待办" />
			{error ? (
				<Alert type="error" showIcon title={error} />
			) : items === null ? (
				<Skeleton active paragraph={{ rows: 1 }} />
			) : (
				<div className="operations-strip">
					{items.map((item) => (
						<button
							key={item.key}
							type="button"
							className="operations-item"
							data-active={item.count > 0}
							onClick={() => navigation.openView(item.view, item.filter)}
						>
							<span>{item.label}</span>
							<strong>{item.count}</strong>
						</button>
					))}
					{data?.pendingRetests.length ? (
						<button
							type="button"
							className="operations-item"
							data-active="true"
							onClick={() => navigation.openBatch(data.pendingRetests[0].id)}
						>
							<span>交付后待复测基线</span>
							<strong>{data.pendingRetests.length}</strong>
						</button>
					) : null}
				</div>
			)}
			{data?.content && (
				<p className="content-summary">
					内容资产 {data.content.total} 篇 · 已登记发布 {data.content.published} 篇
				</p>
			)}
			{data && data.attribution.length > 0 && (
				<>
					<SectionTitle title="近 30 天业务反馈" />
					<Table
						rowKey={(row) => `${row.source_type}:${row.metric}`}
						size="small"
						pagination={false}
						dataSource={data.attribution}
						columns={[
							{
								title: "数据来源",
								dataIndex: "source_type",
								render: (value: string) => sourceLabels[value] ?? value,
							},
							{
								title: "指标",
								dataIndex: "metric",
								render: (value: string) => metricLabels[value] ?? value,
							},
							{ title: "记录合计", dataIndex: "value", render: (value: number) => value.toLocaleString() },
						]}
					/>
				</>
			)}
		</section>
	);
}
