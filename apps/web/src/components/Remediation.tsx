import { IconCheck, IconFileText, IconPlus, IconTrash } from "@tabler/icons-react";
import { Alert, Card, Collapse, Descriptions, Input, Popconfirm, Select, Space, Tag } from "antd";
import { useState } from "react";
import { Button, useAgentRunPolling, usePermission } from "../access";
import { api, patch, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { AgentRun, Paginated, Project, Task } from "../types";
import { Empty, Pagination } from "../ui/primitives";
import { Page } from "./Page";
import "./Remediation.css";

export function Remediation({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const agentRunsPage = usePaginated<AgentRun>(
		(page, pageSize) => {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: String(pageSize),
				purposes: "remediation,content_brief",
			});
			return api<Paginated<AgentRun>>(`/api/projects/${project.id}/agent-runs?${params}`);
		},
		[project.id],
	);
	const agentRuns = agentRunsPage.items;
	const [taskPage, setTaskPage] = useState(1);
	const visibleTasks = project.tasks.slice((taskPage - 1) * 10, taskPage * 10);
	const latestBatch = project.batches[0]?.id;
	useAgentRunPolling(agentRuns, agentRunsPage.reload);
	async function call(id: string, action: () => Promise<unknown>) {
		setBusy(id);
		setError(null);
		try {
			await action();
			await agentRunsPage.reload();
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	const activeRuns = agentRuns.filter((run) =>
		["queued", "running", "awaiting_approval", "failed"].includes(run.status),
	);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="整改中心"
			title="证据驱动的待审批任务"
			description="Pi Agent 只生成草稿；每项任务都要由负责人核对证据、验收标准和发布地址后批准。发布后填写真实 URL，系统重新抓取页面完成验收。"
			extra={
				<div className="actions">
					<Button
						permission="agent.run"
						variant="secondary"
						disabled={!latestBatch}
						busy={busy === "agent-plan"}
						onClick={() =>
							latestBatch &&
							call("agent-plan", () => post(`/api/batches/${latestBatch}/agent`, { purpose: "remediation" }))
						}
					>
						Pi Agent 规划草稿
					</Button>
					<Button
						permission="remediation.manage"
						disabled={!latestBatch}
						busy={busy === "create"}
						icon={<IconPlus size={17} />}
						onClick={() =>
							latestBatch &&
							call("create", () => post(`/api/projects/${project.id}/tasks/from-findings`, { batchId: latestBatch }))
						}
					>
						从已批准诊断建任务
					</Button>
				</div>
			}
		>
			{error && <Alert type="error" showIcon message={error} />}
			{activeRuns.length > 0 && (
				<div className="remediation-runs">
					{activeRuns.map((run) => (
						<AgentRunAlert key={run.id} run={run} reload={agentRunsPage.reload} refresh={refresh} />
					))}
				</div>
			)}
			<Pagination {...agentRunsPage} onPage={(page) => void agentRunsPage.reload(page)} />
			{project.tasks.length === 0 ? (
				<Empty title="还没有整改任务" detail="先完成诊断，再把有证据的结论转换为可跟踪任务。" />
			) : (
				<div className="remediation-list">
					{visibleTasks.map((task) => (
						<TaskItem key={task.id} task={task} busy={busy === task.id} act={(action) => call(task.id, action)} />
					))}
				</div>
			)}
			<Pagination
				page={taskPage}
				pageSize={10}
				total={project.tasks.length}
				totalPages={Math.max(1, Math.ceil(project.tasks.length / 10))}
				onPage={setTaskPage}
			/>
		</Page>
	);
}

export const taskStatusLabels: Record<string, string> = {
	todo: "待处理",
	in_progress: "处理中",
	published: "已发布",
	verified: "已验收",
	done: "已完成",
};

const TASK_STATUS_COLORS: Record<string, string> = {
	todo: "default",
	in_progress: "processing",
	published: "gold",
	verified: "cyan",
	done: "green",
};

export function taskPriorityMeta(priority: string): { className: string; label: string } {
	if (priority === "high") return { className: "high", label: "高优先级" };
	if (priority === "medium" || priority === "mid") return { className: "mid", label: "中优先级" };
	return { className: "low", label: "常规" };
}

function taskPriorityColor(priority: string): string {
	if (priority === "high") return "red";
	if (priority === "medium" || priority === "mid") return "orange";
	return "blue";
}

const STATUS_SELECT_OPTIONS = Object.entries(taskStatusLabels).map(([value, label]) => ({ value, label }));

function AgentRunAlert({ run, reload, refresh }: { run: AgentRun; reload(): Promise<void>; refresh(): Promise<void> }) {
	const purposeLabel = run.purpose === "content_brief" ? "内容简报" : "整改规划";
	if (run.status === "awaiting_approval") {
		return (
			<Alert
				type="warning"
				showIcon
				message={`Pi Agent ${purposeLabel}草稿待人工审批`}
				action={
					<Space size={8}>
						<Button
							permission="agent.approve"
							variant="secondary"
							onClick={() => void post(`/api/agent-runs/${run.id}/reject`).then(() => reload())}
						>
							拒绝
						</Button>
						<Button
							permission="agent.approve"
							onClick={() =>
								void post(`/api/agent-runs/${run.id}/approve`).then(async () => {
									await reload();
									await refresh();
								})
							}
						>
							批准并入库
						</Button>
					</Space>
				}
				description={run.draft ? <DraftView draft={run.draft} /> : undefined}
			/>
		);
	}
	if (run.status === "failed") {
		return (
			<Alert
				type="error"
				showIcon
				message={`Pi Agent ${purposeLabel}运行失败`}
				description={run.error_message ?? undefined}
			/>
		);
	}
	return <Alert type="info" showIcon message={`Pi Agent ${purposeLabel}正在运行（${run.status}）`} />;
}

function DraftView({ draft }: { draft: Record<string, unknown> }) {
	const entries = Object.entries(draft);
	if (entries.length === 0) return <p className="muted">草稿为空。</p>;
	return (
		<Descriptions
			size="small"
			column={1}
			bordered
			items={entries.map(([key, value]) => ({ key, label: key, children: <DraftValue value={value} depth={0} /> }))}
		/>
	);
}

function DraftValue({ value, depth }: { value: unknown; depth: number }) {
	if (value == null) return <>-</>;
	if (typeof value === "string") return <>{value}</>;
	if (typeof value === "number" || typeof value === "boolean") return <>{String(value)}</>;
	if (depth >= 2) return <pre className="draft-leaf">{JSON.stringify(value, null, 2)}</pre>;
	if (Array.isArray(value)) {
		if (value.length === 0) return <>（空列表）</>;
		return (
			<ul className="draft-list">
				{value.map((entry, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 草稿为只读快照，无稳定 id，顺序即语义
					<li key={index}>
						<DraftValue value={entry} depth={depth + 1} />
					</li>
				))}
			</ul>
		);
	}
	return (
		<ul className="draft-list">
			{Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
				<li key={key}>
					<b>{key}：</b>
					<DraftValue value={entry} depth={depth + 1} />
				</li>
			))}
		</ul>
	);
}

export function TaskItem({
	task,
	busy,
	act,
}: {
	task: Task;
	busy: boolean;
	act(action: () => Promise<unknown>): void;
}) {
	const [url, setUrl] = useState(task.published_url ?? "");
	const [owner, setOwner] = useState(task.owner ?? "");
	const [dueDate, setDueDate] = useState(task.due_date ? task.due_date.slice(0, 10) : "");
	const priority = taskPriorityMeta(task.priority);
	const canManage = usePermission("remediation.manage");
	const collapseItems = [
		{
			key: "acceptance",
			label: `验收标准 · 关联 ${task.target_prompt_ids.length} 个问题`,
			children: <p className="task-acceptance">{task.acceptance_criteria}</p>,
		},
		...(task.content_brief
			? [{ key: "brief", label: "内容简报", children: <pre className="task-pre">{task.content_brief}</pre> }]
			: []),
		...(task.draft_content
			? [{ key: "draft", label: "内容初稿", children: <pre className="task-pre">{task.draft_content}</pre> }]
			: []),
	];
	return (
		<Card
			size="small"
			className="remediation-item"
			title={
				<Space size={8} wrap>
					<Tag color={taskPriorityColor(task.priority)}>{priority.label}</Tag>
					<span className="task-title">{task.title}</span>
					{task.verified_snapshot_id && (
						<Tag color="green" icon={<IconCheck size={12} />}>
							已抓取验收 · 快照 {task.verified_snapshot_id}
						</Tag>
					)}
				</Space>
			}
			extra={
				<Space size={8} wrap>
					<Select
						aria-label="任务状态"
						style={{ width: 110 }}
						value={task.status}
						disabled={!canManage}
						options={STATUS_SELECT_OPTIONS}
						onChange={(status) => act(() => patch(`/api/tasks/${task.id}`, { status }))}
					/>
					<Tag color={TASK_STATUS_COLORS[task.status] ?? "default"}>{taskStatusLabels[task.status] ?? task.status}</Tag>
					<Popconfirm
						title="删除该整改任务？"
						okText="删除"
						cancelText="取消"
						onConfirm={() => act(() => api(`/api/tasks/${task.id}`, { method: "DELETE" }))}
					>
						<span>
							<Button
								permission="remediation.manage"
								variant="ghost"
								icon={<IconTrash size={17} />}
								aria-label="删除整改任务"
								title="删除整改任务"
							/>
						</span>
					</Popconfirm>
				</Space>
			}
		>
			<p className="task-detail">{task.detail}</p>
			<Descriptions
				size="small"
				column={{ xs: 1, lg: 2 }}
				items={[
					{ key: "metric", label: "预期指标", children: task.expected_metric },
					{ key: "published", label: "发布地址", children: task.published_url ?? "-" },
				]}
			/>
			<div className="task-meta-row">
				<Button
					permission="agent.run"
					variant="secondary"
					busy={busy}
					icon={<IconFileText size={16} />}
					onClick={() => act(() => post(`/api/tasks/${task.id}/content`))}
				>
					Pi Agent 生成待审批内容
				</Button>
				<Input
					aria-label="负责人"
					placeholder="负责人"
					style={{ width: 130 }}
					disabled={!canManage}
					value={owner}
					onChange={(event) => setOwner(event.target.value)}
				/>
				<Input
					aria-label="截止时间"
					type="date"
					style={{ width: 150 }}
					disabled={!canManage}
					value={dueDate}
					onChange={(event) => setDueDate(event.target.value)}
				/>
				<Button
					permission="remediation.manage"
					variant="secondary"
					onClick={() =>
						act(() =>
							patch(`/api/tasks/${task.id}`, {
								owner: owner || null,
								dueDate: dueDate ? new Date(`${dueDate}T23:59:59+08:00`).toISOString() : null,
							}),
						)
					}
				>
					保存责任人和日期
				</Button>
				<Input
					aria-label="真实发布地址"
					type="url"
					placeholder="https://真实发布地址"
					style={{ width: 230 }}
					value={url}
					disabled={!canManage}
					onChange={(event) => setUrl(event.target.value)}
				/>
				<Button
					permission="remediation.manage"
					variant="secondary"
					onClick={() =>
						act(async () => {
							await patch(`/api/tasks/${task.id}`, { publishedUrl: url, status: "published" });
							await post(`/api/tasks/${task.id}/verify`);
						})
					}
				>
					抓取验收
				</Button>
			</div>
			<Collapse size="small" items={collapseItems} />
		</Card>
	);
}
