import {
	IconActivity,
	IconArchive,
	IconBolt,
	IconCheck,
	IconChevronDown,
	IconClipboardList,
	IconExternalLink,
	IconFileText,
	IconInbox,
	IconPlus,
	IconRefresh,
	IconSparkles,
} from "@tabler/icons-react";
import { Button as AntdButton, Drawer, Modal, Segmented, Select, Table, Tag } from "antd";
import { type ReactNode, useState } from "react";
import { Button } from "../access";
import {
	type AgentRun,
	agentStatusLabels,
	type BatchSummary,
	batchKindLabel,
	type Task,
	taskStatusLabels,
} from "../types";
import { Pagination, shortDate } from "../ui/primitives";
import { Page } from "./Page";
import "./TaskManagementLayout.css";

type Props = {
	projectName: string;
	tasks: Task[];
	runs: AgentRun[];
	runTotal: number;
	runPage: number;
	runPageSize: number;
	onRunPage(page: number): void;
	finishedBatches: BatchSummary[];
	selectedBatch: string | null;
	onSelectBatch(id: string): void;
	busy: string | null;
	error: ReactNode;
	onCreate(): void;
	onPlan(): void;
	onRefresh(): void;
	renderTask(task: Task): ReactNode;
	renderDraft(run: AgentRun): ReactNode;
};
const complete = (task: Task) => ["verified", "done"].includes(task.status);

export function TaskManagementLayout(props: Props) {
	const [panel, setPanel] = useState("tasks"),
		[history, setHistory] = useState(false),
		[page, setPage] = useState(1);
	const [historyPage, setHistoryPage] = useState(1);
	const [selectedId, setSelectedId] = useState<string | null>(null),
		[createMode, setCreateMode] = useState<"create" | "plan" | null>(null);
	const openTasks = props.tasks.filter((task) => !complete(task)),
		finished = props.tasks.filter(complete);
	const selected = props.tasks.find((task) => task.id === selectedId);
	const currentPage = Math.min(page, Math.max(1, Math.ceil(openTasks.length / 10)));
	const currentHistoryPage = Math.min(historyPage, Math.max(1, Math.ceil(finished.length / 10)));
	const stats = [
		{ label: "总任务数", value: props.tasks.length, icon: IconBolt, tone: "blue" },
		{
			label: "进行中",
			value: props.tasks.filter((t) => t.status === "in_progress").length,
			icon: IconActivity,
			tone: "green",
		},
		{ label: "已完成", value: finished.length, icon: IconCheck, tone: "violet" },
		{
			label: "待处理",
			value: props.tasks.filter((t) => t.status === "todo").length,
			icon: IconClipboardList,
			tone: "amber",
		},
	];
	const columns = [
		{
			title: "任务",
			dataIndex: "title",
			key: "title",
			render: (value: string, row: Task) => (
				<button className="task-board-link" type="button" onClick={() => setSelectedId(row.id)}>
					{value}
				</button>
			),
		},
		{
			title: "优先级",
			dataIndex: "priority",
			key: "priority",
			width: 110,
			render: (value: string) => (
				<Tag>{value === "high" ? "高" : value === "medium" || value === "mid" ? "中" : "常规"}</Tag>
			),
		},
		{
			title: "负责人",
			dataIndex: "owner",
			key: "owner",
			width: 130,
			render: (value: string | null) => value || "待分配",
		},
		{ title: "截止日期", dataIndex: "due_date", key: "due", width: 140, render: shortDate },
		{
			title: "状态",
			dataIndex: "status",
			key: "status",
			width: 110,
			render: (value: string) => (
				<Tag color={value === "verified" ? "success" : "default"}>{taskStatusLabels[value] ?? value}</Tag>
			),
		},
		{
			title: "",
			key: "action",
			width: 58,
			render: (_: unknown, row: Task) => (
				<AntdButton
					type="text"
					icon={<IconExternalLink size={16} />}
					title="打开任务"
					onClick={() => setSelectedId(row.id)}
				/>
			),
		},
	];
	return (
		<Page
			className="task-board"
			eyebrow="整改中心"
			title="任务管理"
			description="管理整改任务与内容草稿"
			breadcrumb={props.projectName}
			extra={
				<>
					<Button icon={<IconPlus size={17} />} permission="remediation.manage" onClick={() => setCreateMode("create")}>
						创建任务
					</Button>
					<Button
						variant="secondary"
						icon={<IconSparkles size={17} />}
						permission="agent.run"
						onClick={() => setCreateMode("plan")}
					>
						规划草稿
					</Button>
				</>
			}
		>
			{props.error}
			<div className="task-board-tool">
				<div className="task-board-tool-head">
					<h2>{panel === "tasks" ? "任务列表" : "Agent 草稿"}</h2>
					<Segmented
						size="small"
						value={panel}
						onChange={(value) => setPanel(String(value))}
						options={[
							{ value: "tasks", label: "任务" },
							{ value: "drafts", label: `草稿 ${props.runTotal}` },
						]}
					/>
				</div>
				{panel === "tasks" ? (
					openTasks.length ? (
						<>
							<Table<Task>
								rowKey="id"
								columns={columns}
								dataSource={openTasks.slice((currentPage - 1) * 10, currentPage * 10)}
								pagination={false}
								scroll={{ x: 760 }}
							/>
							<Pagination
								page={currentPage}
								pageSize={10}
								total={openTasks.length}
								totalPages={Math.max(1, Math.ceil(openTasks.length / 10))}
								onPage={setPage}
							/>
						</>
					) : (
						<div className="task-board-empty">
							<IconInbox size={44} />
							<h3>暂无任务</h3>
							<p>从已批准的诊断创建整改任务</p>
							<Button
								permission="remediation.manage"
								icon={<IconPlus size={16} />}
								onClick={() => setCreateMode("create")}
							>
								新建任务
							</Button>
						</div>
					)
				) : props.runs.length ? (
					<div className="task-board-drafts">
						{props.runs.map((run) => (
							<div key={run.id}>{props.renderDraft(run)}</div>
						))}
						<Pagination
							page={props.runPage}
							pageSize={props.runPageSize}
							total={props.runTotal}
							totalPages={Math.max(1, Math.ceil(props.runTotal / props.runPageSize))}
							onPage={props.onRunPage}
						/>
					</div>
				) : (
					<div className="task-board-empty">
						<IconFileText size={44} />
						<h3>暂无草稿</h3>
						<p>选择完成的批次生成整改规划</p>
						<Button permission="agent.run" icon={<IconPlus size={16} />} onClick={() => setCreateMode("plan")}>
							规划草稿
						</Button>
					</div>
				)}
			</div>
			<div className="task-board-history">
				<button
					type="button"
					className="task-board-history-trigger"
					aria-expanded={history}
					onClick={() => setHistory(!history)}
				>
					<span className="task-board-history-icon">
						<IconArchive size={24} />
					</span>
					<span className="task-board-history-label">
						<strong>
							已完成任务 <Tag>共 {finished.length} 个</Tag>
						</strong>
						<small>查看已验收和已结束的任务</small>
					</span>
					<IconChevronDown className={history ? "task-board-rotated" : ""} size={18} />
				</button>
				{history &&
					(finished.length ? (
						<>
							<Table<Task>
								rowKey="id"
								dataSource={finished.slice((currentHistoryPage - 1) * 10, currentHistoryPage * 10)}
								columns={columns}
								pagination={false}
								scroll={{ x: 760 }}
							/>
							<Pagination
								page={currentHistoryPage}
								pageSize={10}
								total={finished.length}
								totalPages={Math.max(1, Math.ceil(finished.length / 10))}
								onPage={setHistoryPage}
							/>
						</>
					) : (
						<div className="task-board-history-empty">暂无已完成任务</div>
					))}
			</div>
			<div className="task-board-stats">
				{stats.map((stat) => (
					<div className="task-board-stat" key={stat.label}>
						<stat.icon className={`task-board-icon-${stat.tone}`} size={27} />
						<div>
							<span>{stat.label}</span>
							<strong>{stat.value}</strong>
						</div>
					</div>
				))}
			</div>
			<div className="task-board-runtime">
				<section className="task-board-runtime-panel">
					<h3>执行状态</h3>
					<div className="task-board-runtime-body">
						{props.runs.length ? (
							<>
								<div className="task-board-runtime-line">
									<span>最近 {props.runs.length} 条记录</span>
									<Tag>{props.runs.filter((r) => r.status === "running").length} 执行中</Tag>
								</div>
								<p>最近更新 {shortDate(props.runs[0].completed_at ?? props.runs[0].created_at)}</p>
								<Button variant="link" icon={<IconRefresh size={15} />} onClick={props.onRefresh}>
									刷新运行记录
								</Button>
							</>
						) : (
							<p>暂无执行记录</p>
						)}
					</div>
				</section>
				<section className="task-board-runtime-panel">
					<h3>任务分布</h3>
					<div className="task-board-runtime-body task-board-distribution">
						{[
							{ label: "待处理", status: "todo", tone: "blue" },
							{ label: "进行中", status: "in_progress", tone: "green" },
							{ label: "待验收", status: "published", tone: "amber" },
							{ label: "已验收", status: "verified", tone: "violet" },
						].map((item) => (
							<div key={item.status} className={`task-board-distribution-${item.tone}`}>
								<span>{item.label}</span>
								<strong>{props.tasks.filter((t) => t.status === item.status).length}</strong>
							</div>
						))}
					</div>
				</section>
				<section className="task-board-runtime-panel">
					<h3>最近运行</h3>
					<div className="task-board-runtime-body">
						{props.runs.length ? (
							<ul>
								{props.runs.slice(0, 3).map((run) => (
									<li key={run.id}>
										<button className="task-board-link" type="button" onClick={() => setPanel("drafts")}>
											{run.purpose === "remediation" ? "整改规划" : "内容简报"}
										</button>
										<Tag>{agentStatusLabels[run.status]}</Tag>
										<small>{shortDate(run.created_at)}</small>
									</li>
								))}
							</ul>
						) : (
							<p>暂无运行记录</p>
						)}
					</div>
				</section>
			</div>
			<Modal
				open={createMode !== null}
				title={createMode === "create" ? "从诊断创建任务" : "生成整改规划"}
				onCancel={() => setCreateMode(null)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setCreateMode(null)}>
							取消
						</Button>
						<Button
							permission={createMode === "create" ? "remediation.manage" : "agent.run"}
							disabled={!props.selectedBatch}
							busy={props.busy !== null}
							onClick={() => {
								if (createMode === "create") props.onCreate();
								else props.onPlan();
								setCreateMode(null);
							}}
						>
							确认
						</Button>
					</>
				}
			>
				<label className="task-board-batch-label" htmlFor="task-board-batch">
					来源批次
				</label>
				<Select
					id="task-board-batch"
					className="task-board-batch"
					value={props.selectedBatch}
					onChange={props.onSelectBatch}
					placeholder="暂无已完成批次"
					options={props.finishedBatches.map((b) => ({
						value: b.id,
						label: `${batchKindLabel(b.kind)} · ${shortDate(b.created_at)}`,
					}))}
				/>
			</Modal>
			<Drawer
				open={!!selected}
				onClose={() => setSelectedId(null)}
				title="任务详情"
				size="large"
				rootClassName="task-board-drawer"
			>
				{selected && props.renderTask(selected)}
			</Drawer>
		</Page>
	);
}
