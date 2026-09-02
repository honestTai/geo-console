import { IconCheck, IconFileText, IconPlus, IconTrash } from "@tabler/icons-react";
import { Alert, Card, Descriptions, Input, Popconfirm, Select, Space, Tag } from "antd";
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

export function taskPriorityMeta(priority: string): { className: string; label: string } {
	if (priority === "high") return { className: "high", label: "高优先级" };
	if (priority === "medium" || priority === "mid") return { className: "mid", label: "中优先级" };
	return { className: "low", label: "常规" };
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
	const [expanded, setExpanded] = useState(false);
	const priority = taskPriorityMeta(task.priority);
	const canManage = usePermission("remediation.manage");
	const dirty =
		owner !== (task.owner ?? "") ||
		dueDate !== (task.due_date ? task.due_date.slice(0, 10) : "") ||
		url !== (task.published_url ?? "");
	return (
		<Card
			size="small"
			className="remediation-item"
			title={
				<div className="task-head">
					<Tag className={`task-priority ${priority.className}`}>{priority.label}</Tag>
					<span className="task-title">{task.title}</span>
					{task.verified_snapshot_id && (
						<Tag icon={<IconCheck size={12} />} className="task-verified">
							已抓取验收
						</Tag>
					)}
				</div>
			}
			extra={
				<Space size={4}>
					<Select
						aria-label="任务状态"
						className="task-status"
						size="small"
						value={task.status}
						disabled={!canManage}
						options={STATUS_SELECT_OPTIONS}
						onChange={(status) => act(() => patch(`/api/tasks/${task.id}`, { status }))}
					/>
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
								size="small"
								icon={<IconTrash size={16} />}
								aria-label="删除整改任务"
								title="删除整改任务"
							/>
						</span>
					</Popconfirm>
				</Space>
			}
		>
			<p className="task-detail">{task.detail}</p>
			<dl className="task-facts">
				<div>
					<dt>预期指标</dt>
					<dd>{task.expected_metric}</dd>
				</div>
				<div>
					<dt>关联问题</dt>
					<dd>{task.target_prompt_ids.length} 个</dd>
				</div>
				<div>
					<dt>发布地址</dt>
					<dd>
						{task.published_url ? (
							<a href={task.published_url} target="_blank" rel="noreferrer">
								{task.published_url}
							</a>
						) : (
							"待发布"
						)}
					</dd>
				</div>
			</dl>
			<div className="task-form">
				<div className="task-field">
					<span>负责人</span>
					<Input
						aria-label="负责人"
						placeholder="姓名"
						disabled={!canManage}
						value={owner}
						onChange={(event) => setOwner(event.target.value)}
					/>
				</div>
				<div className="task-field">
					<span>截止日期</span>
					<Input
						aria-label="截止时间"
						type="date"
						disabled={!canManage}
						value={dueDate}
						onChange={(event) => setDueDate(event.target.value)}
					/>
				</div>
				<div className="task-field task-form-url">
					<span>真实发布地址</span>
					<Input
						aria-label="真实发布地址"
						type="url"
						placeholder="https://"
						value={url}
						disabled={!canManage}
						onChange={(event) => setUrl(event.target.value)}
					/>
				</div>
				<div className="task-form-actions">
					<Button
						permission="remediation.manage"
						variant="secondary"
						disabled={!dirty}
						onClick={() =>
							act(() =>
								patch(`/api/tasks/${task.id}`, {
									owner: owner || null,
									dueDate: dueDate ? new Date(`${dueDate}T23:59:59+08:00`).toISOString() : null,
									publishedUrl: url || null,
								}),
							)
						}
					>
						保存
					</Button>
					<Button
						permission="remediation.manage"
						disabled={!url}
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
			</div>
			<div className="task-footer">
				<Button
					permission="agent.run"
					variant="secondary"
					size="small"
					busy={busy}
					icon={<IconFileText size={15} />}
					onClick={() => act(() => post(`/api/tasks/${task.id}/content`))}
				>
					Agent 生成内容草稿
				</Button>
				<Button variant="link" size="small" onClick={() => setExpanded((value) => !value)}>
					{expanded
						? "收起详情"
						: `查看验收标准${task.content_brief ? "、内容简报" : ""}${task.draft_content ? "与初稿" : ""}`}
				</Button>
			</div>
			{expanded && (
				<div className="task-sections">
					<section>
						<h4>验收标准</h4>
						<p className="task-acceptance">{task.acceptance_criteria}</p>
					</section>
					{task.content_brief && (
						<section>
							<h4>内容简报</h4>
							<pre className="task-pre">{task.content_brief}</pre>
						</section>
					)}
					{task.draft_content && (
						<section>
							<h4>内容初稿</h4>
							<pre className="task-pre">{task.draft_content}</pre>
						</section>
					)}
				</div>
			)}
		</Card>
	);
}
