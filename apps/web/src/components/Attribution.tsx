import { IconRoute, IconUpload } from "@tabler/icons-react";
import type { TableProps } from "antd";
import { Alert, Button as AntdButton, App, Select, Spin, Table, Tag, Upload } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { type AttributionPayload, DEFAULT_PAGE_SIZE, metricLabels, type Project, sourceLabels } from "../types";
import { date, dayDate, Empty, KpiCard, KpiGrid, Pagination, SectionTitle, shortDate } from "../ui/primitives";
import "./Attribution.css";
import { Page } from "./Page";

type AttributionEvent = AttributionPayload["events"][number];
type AttributionImport = AttributionPayload["imports"][number];

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 日报口径（零点）的观察只显示日期；带时刻的表单/来电记录才显示到分钟。 */
function observedLabel(value: string): string {
	const moment = new Date(value);
	return moment.getHours() === 0 && moment.getMinutes() === 0 ? dayDate(value) : date(value);
}

const EVENT_COLUMNS: TableProps<AttributionEvent>["columns"] = [
	{ title: "时间", dataIndex: "observed_at", width: 170, render: (value: string) => observedLabel(value) },
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
	{
		title: "文件",
		key: "file",
		ellipsis: true,
		render: (_, item) => (
			<div className="import-file">
				<span title={item.file_name}>{item.file_name}</span>
				<small className="muted">
					{sourceLabels[item.source_type] ?? item.source_type} · {item.row_count} 行 · {shortDate(item.imported_at)}
				</small>
			</div>
		),
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
			setData(
				await api<AttributionPayload>(
					`/api/projects/${project.id}/attribution?page=${targetPage}&pageSize=${DEFAULT_PAGE_SIZE}`,
				),
			);
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
		<Page
			className="attribution-page"
			breadcrumb={project.name}
			eyebrow="业务归因"
			title="业务数据对照"
			description="导入 GA4、GSC、表单与电话数据并列查看，不推断因果。"
		>
			{error && <Alert type="error" showIcon title={error} />}
			<SectionTitle
				title={
					<>
						<IconRoute size={16} />
						导入真实 CSV
					</>
				}
				description="支持 GA4/GSC 导出宽表或 observed_at、metric、value 标准列；相同文件不重复计数。"
			/>
			<div className="import-band">
				<div className="import-controls">
					{/* biome-ignore lint/a11y/noLabelWithoutControl: antd Select 不渲染原生 input，用包围标签承载标题 */}
					<label>
						数据来源
						<Select
							className="import-source"
							value={sourceType}
							options={Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))}
							onChange={setSourceType}
						/>
					</label>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: antd Upload 不渲染原生 input，用包围标签承载标题 */}
					<label className="file-control">
						CSV 文件
						<span className="file-picker">
							<Upload
								accept=".csv,text/csv"
								maxCount={1}
								showUploadList={false}
								beforeUpload={(picked) => {
									setFile(picked);
									return false;
								}}
							>
								<AntdButton icon={<IconUpload size={16} />}>{file ? "重新选择" : "选择文件"}</AntdButton>
							</Upload>
							{file ? (
								<Tag closable onClose={() => setFile(null)} className="file-picked">
									{file.name} · {fileSize(file.size)}
								</Tag>
							) : (
								<span className="muted">未选择文件</span>
							)}
						</span>
					</label>
					<Button permission="attribution.import" busy={busy} disabled={!file} onClick={importCsv}>
						导入并校验
					</Button>
				</div>
			</div>
			<Alert
				className="attribution-notice"
				type="info"
				showIcon
				title="业务数据与 AI 监测并列展示。系统不会仅凭时间上的同步变化宣称 GEO 整改带来了线索；成交与有效咨询仍需业务人员确认。"
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
					<SectionTitle
						title="业务指标汇总"
						description="数值为已导入记录中相同来源、相同指标的数值之和；含义取决于原始导出字段，不是系统自动检测的 AI 表现，也不能据此证明优化带来成交。"
					/>
					<KpiGrid columns={Math.min(4, Math.max(2, data.summary.length))}>
						{data.summary.map((item) => (
							<KpiCard
								key={`${item.source_type}-${item.metric}`}
								label={`${sourceLabels[item.source_type] ?? item.source_type} · ${metricLabels[item.metric] ?? item.metric}`}
								value={item.value.toLocaleString("zh-CN")}
								hint={`${item.observations} 条观察 · 至 ${dayDate(item.last_observed_at)}`}
							/>
						))}
					</KpiGrid>
					<div className="attribution-columns">
						<div>
							<SectionTitle title="最近业务观察" />
							<Table size="middle" rowKey="id" pagination={false} dataSource={data.events} columns={EVENT_COLUMNS} />
						</div>
						<aside>
							<SectionTitle title="导入记录" />
							<Table size="middle" rowKey="id" pagination={false} dataSource={data.imports} columns={IMPORT_COLUMNS} />
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
		</Page>
	);
}
