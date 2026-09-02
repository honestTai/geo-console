import { IconRoute } from "@tabler/icons-react";
import type { TableProps } from "antd";
import { Alert, App, Card, Select, Spin, Statistic, Table, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { type AttributionPayload, metricLabels, type Project, sourceLabels } from "../types";
import { date, Empty, Pagination } from "../ui/primitives";

type AttributionEvent = AttributionPayload["events"][number];
type AttributionImport = AttributionPayload["imports"][number];

const EVENT_COLUMNS: TableProps<AttributionEvent>["columns"] = [
	{ title: "时间", dataIndex: "observed_at", width: 170, render: (value: string) => date(value) },
	{
		title: "指标",
		key: "metric",
		render: (_, event) =>
			`${sourceLabels[event.source_type] ?? event.source_type} · ${metricLabels[event.metric] ?? event.metric}`,
	},
	{
		title: "来源地址",
		key: "source",
		ellipsis: true,
		render: (_, event) => event.landing_url ?? event.channel ?? "-",
	},
	{
		title: "数值",
		dataIndex: "value",
		align: "right",
		width: 110,
		render: (value: number) => value.toLocaleString("zh-CN"),
	},
];

const IMPORT_COLUMNS: TableProps<AttributionImport>["columns"] = [
	{ title: "文件名", dataIndex: "file_name", ellipsis: true },
	{
		title: "来源",
		key: "source",
		width: 130,
		render: (_, item) => sourceLabels[item.source_type] ?? item.source_type,
	},
	{ title: "行数", dataIndex: "row_count", width: 90, align: "right" },
	{
		title: "导入时间",
		dataIndex: "imported_at",
		width: 175,
		align: "right",
		render: (value: string) => date(value),
	},
];

export function Attribution({ project }: { project: Project }) {
	const { message } = App.useApp();
	const [data, setData] = useState<AttributionPayload | null>(null);
	const [sourceType, setSourceType] = useState("ga4");
	const [file, setFile] = useState<File | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [page, setPage] = useState(1);
	const load = useCallback(
		async (targetPage = page) => {
			setData(await api<AttributionPayload>(`/api/projects/${project.id}/attribution?page=${targetPage}&pageSize=20`));
		},
		[page, project.id],
	);
	useEffect(() => {
		void load().catch((reason) => setError(reason instanceof Error ? reason.message : "归因数据加载失败"));
	}, [load]);
	async function importCsv() {
		if (!file) return;
		setBusy(true);
		try {
			await post(`/api/projects/${project.id}/attribution/import`, {
				sourceType,
				fileName: file.name,
				csv: await file.text(),
			});
			setFile(null);
			message.success("CSV 已导入并完成校验");
			await load();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "归因数据导入失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="attribution-page">
			<div className="overview-head">
				<div>
					<span className="eyebrow">业务归因</span>
					<h2>业务数据与 GEO 指标并列观察</h2>
					<p className="muted">导入 GA4、Search Console、表单、电话和业务台账；系统防重复计数，但不自动声称因果。</p>
				</div>
			</div>
			{error && <Alert type="error" showIcon message={error} />}
			<div className="import-band">
				<div>
					<IconRoute size={25} />
					<h3>导入真实 CSV</h3>
					<p>支持 GA4/GSC 常见宽表，或 observed_at、metric、value、landing_url 标准列；相同文件不会重复计数。</p>
				</div>
				<div className="import-controls">
					{/* biome-ignore lint/a11y/noLabelWithoutControl: antd Select 不渲染原生 input，用包围标签承载标题 */}
					<label>
						数据来源
						<Select
							style={{ width: "100%" }}
							value={sourceType}
							options={Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))}
							onChange={setSourceType}
						/>
					</label>
					<label className="file-control">
						CSV 文件
						<input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
					</label>
					<Button permission="attribution.import" busy={busy} disabled={!file} onClick={importCsv}>
						导入并校验
					</Button>
				</div>
			</div>
			<Alert
				type="info"
				showIcon
				message="业务数据与 AI 监测并列展示。系统不会仅凭时间上的同步变化宣称 GEO 整改带来了线索；成交与有效咨询仍需业务人员确认。"
			/>
			{!data ? (
				<div className="center">
					<Spin />
				</div>
			) : data.summary.length === 0 ? (
				<Empty
					title="还没有真实归因数据"
					detail="导入客户自己的导出文件后，这里才会显示访问、搜索点击、表单或电话指标。"
				/>
			) : (
				<>
					<div className="attribution-kpis">
						{data.summary.map((item) => (
							<Card size="small" key={`${item.source_type}-${item.metric}`}>
								<Statistic
									title={`${sourceLabels[item.source_type] ?? item.source_type} · ${metricLabels[item.metric] ?? item.metric}`}
									value={item.value}
								/>
								<Typography.Text type="secondary" style={{ fontSize: 12 }}>
									{item.observations} 条观察 · 至 {date(item.last_observed_at)}
								</Typography.Text>
							</Card>
						))}
					</div>
					<div className="attribution-columns">
						<div>
							<h3>最近业务观察</h3>
							<Table size="small" rowKey="id" pagination={false} dataSource={data.events} columns={EVENT_COLUMNS} />
						</div>
						<aside>
							<h3>导入记录</h3>
							<Table size="small" rowKey="id" pagination={false} dataSource={data.imports} columns={IMPORT_COLUMNS} />
						</aside>
					</div>
					<Pagination
						{...data.eventsPagination}
						onPage={(targetPage) => {
							setPage(targetPage);
							void load(targetPage);
						}}
					/>
				</>
			)}
		</section>
	);
}
