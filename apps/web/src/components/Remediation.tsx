import { IconCheck, IconFileText, IconPlus, IconTrash } from "@tabler/icons-react";
import { Alert, Card, DatePicker, Input, Popconfirm, Select, Space, Tag } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { Button, useAgentRunPolling, usePermission } from "../access";
import { api, patch, post } from "../api";
import { useEvidenceIndex } from "../hooks/useEvidenceIndex";
import { usePaginated } from "../hooks/usePagination";
import {
	type AgentRun,
	batchKindLabel,
	DEFAULT_PAGE_SIZE,
	type Paginated,
	type Project,
	type Task,
	taskStatusLabels,
} from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { Empty, Pagination, SectionTitle, shortDate } from "../ui/primitives";
import { AgentDraftCard } from "./AgentDraft";
import { Page } from "./Page";
import "./Remediation.css";

export function Remediation({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const navigation = useWorkspaceNavigation();
	// 规划草稿与建任务都要指向一个已完成的批次；默认最近完成的一条，成员可切换到已诊断的其他批次。
	const finishedBatches = project.batches.filter((batch) => ["complete", "partial"].includes(batch.status));
	const [selectedBatch, setSelectedBatch] = useState<string | null>(finishedBatches[0]?.id ?? null);
	useEffect(() => {
		if (!selectedBatch || !finishedBatches.some((batch) => batch.id === selectedBatch))
			setSelectedBatch(finishedBatches[0]?.id ?? null);
	}, [finishedBatches, selectedBatch]);
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
	const visibleTasks = project.tasks.slice((taskPage - 1) * DEFAULT_PAGE_SIZE, taskPage * DEFAULT_PAGE_SIZE);
	useAgentRunPolling(agentRuns, agentRunsPage.reload);
	const activeRuns = agentRuns.filter((run) =>
		["queued", "running", "awaiting_approval", "failed"].includes(run.status),
	);
	// 草稿引用的证据按其批次翻译；待审批草稿通常都来自当前选中的完成批次
	const draftBatchId = activeRuns.find((run) => run.batch_id)?.batch_id ?? selectedBatch ?? null;
	const evidenceIndex = useEvidenceIndex(draftBatchId, project.id);
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
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="整改中心"
			title="整改任务"
			description="Agent 只出草稿，负责人核对后批准；发布后填写地址，系统重抓验收。"
			extra={
				<div className="actions">
					<Select
						aria-label="来源批次"
						className="remediation-batch"
						value={selectedBatch}
						placeholder="没有已完成批次"
						disabled={!finishedBatches.length}
						onChange={setSelectedBatch}
						options={finishedBatches.map((batch) => ({
							value: batch.id,
							label: `${batchKindLabel(batch.kind)} · ${shortDate(batch.created_at)}`,
						}))}
					/>
					<Button
						permission="agent.run"
						variant="secondary"
						disabled={!selectedBatch}
						busy={busy === "agent-plan"}
						onClick={() =>
							selectedBatch &&
							call("agent-plan", () => post(`/api/batches/${selectedBatch}/agent`, { purpose: "remediation" }))
						}
					>
						HRouter Agent 规划草稿
					</Button>
					<Button
						permission="remediation.manage"
						disabled={!selectedBatch}
						busy={busy === "create"}
						icon={<IconPlus size={17} />}
						onClick={() =>
							selectedBatch &&
							call("create", () => post(`/api/projects/${project.id}/tasks/from-findings`, { batchId: selectedBatch }))
						}
					>
						从已批准诊断建任务
					</Button>
				</div>
			}
		>
			{error && <Alert type="error" showIcon title={error} />}
			{activeRuns.length > 0 && (
				<>
					<SectionTitle title="Agent 草稿" count={activeRuns.length} description="批准后才会写入任务或内容简报。" />
					<div className="agent-draft-list">
						{activeRuns.map((run) => (
							<AgentDraftCard
								key={run.id}
								run={run}
								evidenceIndex={evidenceIndex}
								onOpenEvidence={(id, kind) => navigation.openEvidence(id, run.batch_id, kind)}
								tasks={project.tasks}
								busy={busy === run.id}
								onReject={() => call(run.id, () => post(`/api/agent-runs/${run.id}/reject`))}
								onApprove={() => call(run.id, () => post(`/api/agent-runs/${run.id}/approve`))}
							/>
						))}
					</div>
					<Pagination {...agentRunsPage} onPage={(page) => void agentRunsPage.reload(page)} />
				</>
			)}
			<SectionTitle title="整改任务" count={project.tasks.length || undefined} />
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
				pageSize={DEFAULT_PAGE_SIZE}
				total={project.tasks.length}
				totalPages={Math.max(1, Math.ceil(project.tasks.length / DEFAULT_PAGE_SIZE))}
				onPage={setTaskPage}
			/>
		</Page>
	);
}

export function taskPriorityMeta(priority: string): { className: string; label: string } {
	if (priority === "high") return { className: "high", label: "高优先级" };
	if (priority === "medium" || priority === "mid") return { className: "mid", label: "中优先级" };
	return { className: "low", label: "常规" };
}

function TaskVerifiedTag({ task }: { task: Task }) {
	const label = task.verified_audit_id ? "已审计验收" : task.verified_snapshot_id ? "已抓取验收" : null;
	if (!label) return null;
	return (
		<Tag icon={<IconCheck size={12} />} className="task-verified">
			{label}
		</Tag>
	);
}

/** 验收入口按服务端给出的方式展示：技术类任务重跑官网审计，其余发布后按官网域名抓取快照。 */
function TaskVerifyButton({
	task,
	url,
	busy,
	act,
}: {
	task: Task;
	url: string;
	busy: boolean;
	act(action: () => Promise<unknown>): void;
}) {
	if (task.verification_mode === "audit")
		return (
			<Button
				permission="remediation.manage"
				busy={busy}
				title="技术类整改按验收标准重跑官网审计，无阻断项才算通过"
				onClick={() => act(() => post(`/api/tasks/${task.id}/verify`))}
			>
				重跑审计验收
			</Button>
		);
	return (
		<Button
			permission="remediation.manage"
			disabled={!url}
			busy={busy}
			title="重新抓取发布页面形成快照；地址必须在客户官网域名下"
			onClick={() =>
				act(async () => {
					await patch(`/api/tasks/${task.id}`, { publishedUrl: url, status: "published" });
					await post(`/api/tasks/${task.id}/verify`);
				})
			}
		>
			抓取验收
		</Button>
	);
}

/** “已验收”只能由验收动作写入：下拉里保留它只是为了显示当前状态，不能手工选中。 */
const STATUS_SELECT_OPTIONS = Object.entries(taskStatusLabels).map(([value, label]) => ({
	value,
	label,
	disabled: value === "verified",
}));

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
	const auditMode = task.verification_mode === "audit";
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
					<TaskVerifiedTag task={task} />
				</div>
			}
			extra={
				<Space size={4}>
					<Button
						permission="agent.run"
						variant="secondary"
						size="small"
						busy={busy}
						icon={<IconFileText size={14} />}
						onClick={() => act(() => post(`/api/tasks/${task.id}/content`))}
					>
						生成内容草稿
					</Button>
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
			<div className="task-meta">
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
				<Button variant="link" size="small" onClick={() => setExpanded((value) => !value)}>
					{expanded
						? "收起详情"
						: `查看验收标准${task.content_brief ? "、内容简报" : ""}${task.draft_content ? "与初稿" : ""}`}
				</Button>
			</div>
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
					<DatePicker
						aria-label="截止日期"
						placeholder="选择日期"
						disabled={!canManage}
						value={dueDate ? dayjs(dueDate) : null}
						onChange={(value) => setDueDate(value ? value.format("YYYY-MM-DD") : "")}
					/>
				</div>
				{!auditMode && (
					<div className="task-field task-form-url">
						<span>真实发布地址</span>
						<Input
							aria-label="真实发布地址"
							type="url"
							placeholder="https://（须在客户官网域名下）"
							value={url}
							disabled={!canManage}
							onChange={(event) => setUrl(event.target.value)}
						/>
					</div>
				)}
				<div className="task-form-actions">
					<Button
						permission="remediation.manage"
						variant="secondary"
						disabled={!dirty || busy}
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
					<TaskVerifyButton task={task} url={url} busy={busy} act={act} />
				</div>
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
