import {
	IconArrowUp,
	IconCheck,
	IconCircleCheck,
	IconCircleX,
	IconHourglassHigh,
	IconLoader2,
	IconPlus,
	IconSparkles,
	IconTool,
} from "@tabler/icons-react";
import { App, Checkbox, Input, Popconfirm, Radio, Select, Space, Steps, Switch, Tag, Tooltip } from "antd";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, patch, post } from "../api";
import {
	type AgentSessionPlanStep,
	type Paginated,
	type Project,
	sessionStatusLabel,
	thinkingLevelOptions,
	type WorkbenchEvent,
	type WorkbenchQuickCommand,
	type WorkbenchSession,
} from "../types";
import { FormattedAnswer } from "../ui/markdown";
import { useWorkspaceNavigation } from "../ui/navigation";
import { Empty, shortDate } from "../ui/primitives";
import { Page } from "./Page";
import "./Workbench.css";

type SessionList = Paginated<WorkbenchSession> & { quickCommands: WorkbenchQuickCommand[] };

const toolLabels: Record<string, string> = {
	read_project_context: "读取客户项目",
	read_batch_evidence_index: "读取证据索引",
	read_evidence: "读取证据",
	suggest_questions: "整理问题候选",
	ask_user: "向你提问",
	apply_scope: "应用监测问题",
	create_batch: "创建采集批次",
	get_batch_status: "查看批次状态",
	wait_for: "等待后台任务",
	verify_batch: "核验采集结果",
	run_site_audit: "官网审计",
	run_rule_diagnosis: "规则诊断",
	run_agent_draft: "Agent 草稿",
	advance_report: "推进报告",
	generate_articles: "生成优化文章",
	finish: "完成",
};

const purposeLabels: Record<string, string> = {
	diagnosis: "模型诊断",
	remediation: "整改规划",
	report_narrative: "报告叙述",
	quality_review: "报告质检",
	optimization_article: "优化文章",
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One switch maps every tool result to a user-facing sentence.
function describeToolEnd(tool: string, details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const value = details as Record<string, unknown>;
	switch (tool) {
		case "create_batch":
			return `批次已创建 · ${value.jobCount ?? "?"} 个采集任务 · 平台 ${Array.isArray(value.platforms) ? value.platforms.length : "?"} 个`;
		case "apply_scope":
			return `监测问题已更新 · ${value.promptCount ?? "?"} 个问题`;
		case "run_site_audit": {
			const result = value.result as { score?: number } | undefined;
			return `官网审计完成 · ${result?.score ?? "-"} 分`;
		}
		case "run_rule_diagnosis":
			return `规则诊断 ${value.findings ?? 0} 条 · 整改任务 ${(value.tasks as { count?: number } | undefined)?.count ?? 0} 条`;
		case "advance_report":
			return `报告工作流：${String(value.state ?? "")}`;
		case "generate_articles":
			return `已排队 ${Array.isArray(value.queued) ? value.queued.length : 0} 篇优化文章`;
		case "verify_batch":
			return `核验 ${value.total ?? 0} 条采集`;
		case "get_batch_status":
			return `批次 ${String(value.status ?? "")} · 已采集 ${value.captured ?? 0}`;
		case "wait_for":
			return value.alreadyDone ? "对象已完成" : "已挂起等待";
		case "suggest_questions":
			return `现有 ${Array.isArray(value.current) ? value.current.length : 0} 个问题 · 知识库候选 ${Array.isArray(value.libraryCandidates) ? value.libraryCandidates.length : 0} 个`;
		default:
			return null;
	}
}

type Bubble =
	| { kind: "user"; seq: number; text: string; at: string }
	| { kind: "assistant"; seq: number; text: string; at: string; streaming: boolean }
	| { kind: "tool"; seq: number; tool: string; status: "running" | "done" | "error"; detail: string | null; at: string }
	| {
			kind: "question";
			seq: number;
			question: string;
			options: string[];
			multiple: boolean;
			at: string;
			answered: boolean;
	  }
	| { kind: "system"; seq: number; text: string; tone: "info" | "success" | "error"; at: string };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Event folding needs to consider every event type in one pass to keep bubble ordering stable.
function foldEvents(events: WorkbenchEvent[]): Bubble[] {
	const bubbles: Bubble[] = [];
	const streaming = new Map<number, number>();
	for (const event of events) {
		const payload = event.payload;
		const at = event.created_at;
		switch (event.type) {
			case "user_message":
			case "user_answer": {
				const last = bubbles.at(-1);
				if (last?.kind === "question") last.answered = true;
				for (const bubble of bubbles) if (bubble.kind === "question") bubble.answered = true;
				bubbles.push({ kind: "user", seq: event.seq, text: String(payload.text ?? ""), at });
				break;
			}
			case "assistant_delta": {
				const turn = Number(payload.turn ?? 0);
				const index = streaming.get(turn);
				if (index !== undefined) {
					const bubble = bubbles[index];
					if (bubble?.kind === "assistant") bubble.text = String(payload.text ?? "");
				} else {
					streaming.set(turn, bubbles.length);
					bubbles.push({ kind: "assistant", seq: event.seq, text: String(payload.text ?? ""), at, streaming: true });
				}
				break;
			}
			case "assistant_message": {
				const turn = Number(payload.turn ?? 0);
				const index = streaming.get(turn);
				if (index !== undefined) {
					const bubble = bubbles[index];
					if (bubble?.kind === "assistant") {
						bubble.text = String(payload.text ?? "");
						bubble.streaming = false;
					}
					streaming.delete(turn);
				} else
					bubbles.push({ kind: "assistant", seq: event.seq, text: String(payload.text ?? ""), at, streaming: false });
				break;
			}
			case "tool_start":
				bubbles.push({ kind: "tool", seq: event.seq, tool: String(payload.tool), status: "running", detail: null, at });
				break;
			case "tool_end": {
				const tool = String(payload.tool);
				const open = [...bubbles]
					.reverse()
					.find((item) => item.kind === "tool" && item.tool === tool && item.status === "running");
				const detail = payload.isError
					? String(payload.details ?? "工具执行失败")
					: describeToolEnd(tool, payload.details);
				if (open && open.kind === "tool") {
					open.status = payload.isError ? "error" : "done";
					open.detail = detail;
				} else
					bubbles.push({ kind: "tool", seq: event.seq, tool, status: payload.isError ? "error" : "done", detail, at });
				break;
			}
			case "question":
				bubbles.push({
					kind: "question",
					seq: event.seq,
					question: String(payload.question ?? ""),
					options: Array.isArray(payload.options) ? payload.options.map(String) : [],
					multiple: Boolean(payload.multiple),
					at,
					answered: false,
				});
				break;
			case "waiting": {
				const waiting = payload.waiting as { kind: string; label?: string } | undefined;
				bubbles.push({
					kind: "system",
					seq: event.seq,
					tone: "info",
					text: `等待「${waiting?.label ?? waiting?.kind ?? "后台任务"}」完成，完成后会自动继续。你可以离开此页面。`,
					at,
				});
				break;
			}
			case "resumed":
				bubbles.push({
					kind: "system",
					seq: event.seq,
					tone: "success",
					text: String(payload.summary ?? "后台任务已完成"),
					at,
				});
				break;
			case "auto_approved":
				bubbles.push({
					kind: "system",
					seq: event.seq,
					tone: "success",
					text: `已自动批准${purposeLabels[String(payload.purpose)] ?? String(payload.purpose)}草稿${payload.summary ? `：${String(payload.summary).slice(0, 200)}` : ""}`,
					at,
				});
				break;
			case "auto_approve_failed":
				bubbles.push({
					kind: "system",
					seq: event.seq,
					tone: "error",
					text: `自动批准${purposeLabels[String(payload.purpose)] ?? String(payload.purpose)}失败：${String(payload.message ?? "")}`,
					at,
				});
				break;
			case "finished":
				bubbles.push({ kind: "assistant", seq: event.seq, text: String(payload.summary ?? ""), at, streaming: false });
				bubbles.push({ kind: "system", seq: event.seq, tone: "success", text: "本次任务已完成。", at });
				break;
			case "error":
				bubbles.push({
					kind: "system",
					seq: event.seq,
					tone: "error",
					text: String(payload.message ?? "执行失败"),
					at,
				});
				break;
			case "session_cancelled":
				bubbles.push({ kind: "system", seq: event.seq, tone: "error", text: "会话已终止。", at });
				break;
			default:
				break;
		}
	}
	return bubbles;
}

/** 会话已结束（完成/失败/终止）时，尚未跑完的步骤不再转圈，按结果标记。 */
function PlanSteps({ plan, ended }: { plan: AgentSessionPlanStep[]; ended: boolean }) {
	if (!plan.length) return null;
	return (
		<Steps
			className="wb-plan"
			size="small"
			orientation="vertical"
			items={plan.map((step) => {
				const running = step.status === "running" && !ended;
				return {
					title: step.label,
					description: step.detail ?? undefined,
					status:
						step.status === "done"
							? "finish"
							: step.status === "failed" || (step.status === "running" && ended)
								? "error"
								: running
									? "process"
									: "wait",
					icon: running ? <IconLoader2 className="spin" size={16} /> : undefined,
				};
			})}
		/>
	);
}

function QuestionCard({
	bubble,
	disabled,
	onAnswer,
}: {
	bubble: Extract<Bubble, { kind: "question" }>;
	disabled: boolean;
	onAnswer(selected: string[], answer: string): Promise<void>;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const [answer, setAnswer] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="wb-question">
			<div className="wb-question-text">
				<FormattedAnswer value={bubble.question} />
			</div>
			{!bubble.answered && (
				<>
					{bubble.options.length > 0 &&
						(bubble.multiple ? (
							<Checkbox.Group
								className="wb-question-options"
								value={selected}
								onChange={(values) => setSelected(values as string[])}
								options={bubble.options.map((option) => ({ label: option, value: option }))}
							/>
						) : (
							<Radio.Group
								className="wb-question-options"
								value={selected[0]}
								onChange={(event) => setSelected([event.target.value])}
								options={bubble.options.map((option) => ({ label: option, value: option }))}
							/>
						))}
					<Input.TextArea
						autoSize={{ minRows: 1, maxRows: 4 }}
						placeholder={bubble.options.length ? "补充说明（可选）" : "输入你的回答"}
						value={answer}
						onChange={(event) => setAnswer(event.target.value)}
					/>
					<Button
						icon={<IconCheck size={16} />}
						busy={busy}
						disabled={disabled || (!selected.length && !answer.trim())}
						onClick={async () => {
							setBusy(true);
							try {
								await onAnswer(selected, answer.trim());
							} finally {
								setBusy(false);
							}
						}}
					>
						提交回答
					</Button>
				</>
			)}
			{bubble.answered && <span className="wb-question-answered">已回答</span>}
		</div>
	);
}

function ToolBubble({ bubble }: { bubble: Extract<Bubble, { kind: "tool" }> }) {
	const icon =
		bubble.status === "running" ? (
			<IconLoader2 className="spin" size={15} />
		) : bubble.status === "error" ? (
			<IconCircleX size={15} />
		) : (
			<IconCircleCheck size={15} />
		);
	return (
		<div className={`wb-tool ${bubble.status}`}>
			<span className="wb-tool-icon">{icon}</span>
			<span className="wb-tool-name">{toolLabels[bubble.tool] ?? bubble.tool}</span>
			{bubble.detail && <span className="wb-tool-detail">{bubble.detail}</span>}
		</div>
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The workbench view owns session polling, composer state and bubble rendering in one auditable component.
export function Workbench({
	project,
	initialMessage,
	onConsumeInitial,
	refresh,
}: {
	project: Project;
	initialMessage: string | null;
	onConsumeInitial(): void;
	refresh(): Promise<void>;
}) {
	const { message } = App.useApp();
	const navigation = useWorkspaceNavigation();
	const canRun = usePermission("workbench.run");
	const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
	const [quickCommands, setQuickCommands] = useState<WorkbenchQuickCommand[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [session, setSession] = useState<WorkbenchSession | null>(null);
	const [events, setEvents] = useState<WorkbenchEvent[]>([]);
	const [draft, setDraft] = useState(initialMessage ?? "");
	const [busy, setBusy] = useState(false);
	const [models, setModels] = useState<string[]>([]);
	const [newSession, setNewSession] = useState<{ model: string | null; thinkingLevel: string | null; autoApprove: boolean }>({
		model: null,
		thinkingLevel: null,
		autoApprove: true,
	});
	const lastSeq = useRef(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const loadSessions = useCallback(async () => {
		const result = await api<SessionList>(`/api/projects/${project.id}/workbench/sessions?pageSize=50`);
		setSessions(result.items);
		setQuickCommands(result.quickCommands ?? []);
		return result.items;
	}, [project.id]);
	const loadSession = useCallback(async (id: string, reset: boolean) => {
		const [detail, page] = await Promise.all([
			api<WorkbenchSession>(`/api/workbench/sessions/${id}`),
			api<{ items: WorkbenchEvent[]; lastSeq: number }>(
				`/api/workbench/sessions/${id}/events?after=${reset ? 0 : lastSeq.current}`,
			),
		]);
		setSession(detail);
		if (page.items.length) {
			lastSeq.current = page.lastSeq;
			setEvents((current) => (reset ? page.items : [...current, ...page.items]));
		} else if (reset) setEvents([]);
	}, []);
	useEffect(() => {
		void loadSessions()
			.then((items) => {
				if (!activeId && items[0] && !initialMessage) setActiveId(items[0].id);
			})
			.catch((reason) => message.error(reason instanceof Error ? reason.message : "会话加载失败"));
	}, [loadSessions, message, activeId, initialMessage]);
	useEffect(() => {
		// 模型列表只用于下拉选择；读取失败时仍可用平台设置里的默认模型。
		api<{ models: Array<{ id: string }> }>("/api/settings/hrouter/models")
			.then((result) => setModels(result.models.map((item) => item.id)))
			.catch(() => setModels([]));
	}, []);
	useEffect(() => {
		if (!activeId) {
			setSession(null);
			setEvents([]);
			return;
		}
		lastSeq.current = 0;
		void loadSession(activeId, true).catch((reason) =>
			message.error(reason instanceof Error ? reason.message : "会话加载失败"),
		);
	}, [activeId, loadSession, message]);
	const polling = session ? ["running", "waiting_job"].includes(session.status) : false;
	useEffect(() => {
		if (!activeId || !polling) return;
		const interval = session?.status === "running" ? 1500 : 5000;
		const timer = window.setInterval(() => {
			void loadSession(activeId, false).catch(() => undefined);
		}, interval);
		return () => window.clearInterval(timer);
	}, [activeId, polling, session?.status, loadSession]);
	useEffect(() => {
		if (session && ["done", "failed", "waiting_user", "idle"].includes(session.status)) {
			void loadSessions().catch(() => undefined);
			void refresh().catch(() => undefined);
		}
	}, [session?.status, session, loadSessions, refresh]);
	const bubbles = useMemo(() => foldEvents(events), [events]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 事件数量变化时滚到底部。
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	}, [bubbles.length, session?.status]);

	async function startSession(text: string) {
		const value = text.trim();
		if (!value) return;
		setBusy(true);
		try {
			const created = await post<{ id: string }>(`/api/projects/${project.id}/workbench/sessions`, {
				message: value,
				autoApprove: newSession.autoApprove,
				thinkingLevel: newSession.thinkingLevel,
				model: newSession.model,
			});
			setDraft("");
			onConsumeInitial();
			await loadSessions();
			setActiveId(created.id);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "创建会话失败");
		} finally {
			setBusy(false);
		}
	}
	async function send(text: string) {
		const value = text.trim();
		if (!value) return;
		if (!activeId || !session || ["done", "failed"].includes(session.status)) return startSession(value);
		setBusy(true);
		try {
			await post(`/api/workbench/sessions/${activeId}/messages`, { message: value });
			setDraft("");
			await loadSession(activeId, false);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "发送失败");
		} finally {
			setBusy(false);
		}
	}
	async function answer(selected: string[], text: string) {
		if (!activeId) return;
		try {
			await post(`/api/workbench/sessions/${activeId}/answer`, { selected, answer: text || undefined });
			await loadSession(activeId, false);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "提交失败");
		}
	}
	async function updateSettings(values: { autoApprove?: boolean; thinkingLevel?: string | null; model?: string | null }) {
		if (!activeId) return;
		try {
			await patch(`/api/workbench/sessions/${activeId}/settings`, values);
			await loadSession(activeId, false);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "保存失败");
		}
	}
	const inputDisabled = !canRun || busy || session?.status === "running" || session?.status === "waiting_user";
	const modelOptions = (current: string | null) => [
		{ value: "default", label: "跟随平台设置" },
		...[...new Set([...models, ...(current && !models.includes(current) ? [current] : [])])].map((id) => ({
			value: id,
			label: id,
		})),
	];
	const composerPlaceholder =
		session?.status === "waiting_user"
			? "请先在上方回答 HRouter Agent 的问题"
			: session?.status === "running"
				? "HRouter Agent 正在执行…"
				: "输入指令，例如：跑一次正式基线并生成报告";

	const sidebar = (
		<aside className="wb-sessions">
			<div className="wb-sessions-head">
				<h3>会话</h3>
				<Button
					variant="secondary"
					size="small"
					icon={<IconPlus size={14} />}
					permission="workbench.run"
					onClick={() => {
						setActiveId(null);
						setDraft("");
					}}
				>
					新会话
				</Button>
			</div>
			<div className="wb-sessions-list">
				{sessions.map((item) => (
					<button
						type="button"
						key={item.id}
						className={`wb-session-item ${item.id === activeId ? "active" : ""}`}
						onClick={() => setActiveId(item.id)}
					>
						<strong>{item.title}</strong>
						<span>
							<Tag className={`wb-status ${item.status}`}>{sessionStatusLabel[item.status]}</Tag>
							<time>{shortDate(item.updated_at)}</time>
						</span>
					</button>
				))}
				{!sessions.length && <p className="wb-sessions-empty">还没有会话。输入一条指令开始。</p>}
			</div>
		</aside>
	);

	const composer = (
		<div className="wb-composer">
			{quickCommands.length > 0 && (!session || ["done", "failed", "idle"].includes(session.status)) && (
				<div className="wb-quick">
					{quickCommands.map((command) => (
						<button
							type="button"
							key={command.key}
							className="wb-quick-chip"
							disabled={!canRun || busy}
							onClick={() => void send(command.message)}
						>
							<IconSparkles size={13} />
							{command.label}
						</button>
					))}
				</div>
			)}
			<div className="wb-composer-row">
				<Input.TextArea
					autoSize={{ minRows: 1, maxRows: 6 }}
					placeholder={composerPlaceholder}
					value={draft}
					disabled={inputDisabled}
					onChange={(event) => setDraft(event.target.value)}
					onPressEnter={(event) => {
						if (event.shiftKey) return;
						event.preventDefault();
						void send(draft);
					}}
				/>
				<Button
					icon={<IconArrowUp size={16} />}
					busy={busy}
					disabled={inputDisabled || !draft.trim()}
					permission="workbench.run"
					onClick={() => void send(draft)}
					aria-label="发送"
				/>
			</div>
			{(!session || ["done", "failed"].includes(session.status)) && (
				<div className="wb-new-settings">
					<span className="wb-setting">
						模型
						<Select
							size="small"
							className="wb-model-select"
							value={newSession.model ?? "default"}
							disabled={!canRun}
							popupMatchSelectWidth={false}
							onChange={(value) => setNewSession({ ...newSession, model: value === "default" ? null : value })}
							options={modelOptions(newSession.model)}
						/>
					</span>
					<span className="wb-setting">
						思考强度
						<Select
							size="small"
							className="wb-thinking"
							value={newSession.thinkingLevel ?? "default"}
							disabled={!canRun}
							popupMatchSelectWidth={false}
							onChange={(value) => setNewSession({ ...newSession, thinkingLevel: value === "default" ? null : value })}
							options={[
								{ value: "default", label: "跟随平台设置" },
								...thinkingLevelOptions.map((item) => ({ value: item.value, label: item.label })),
							]}
						/>
					</span>
					<Tooltip title="开启后草稿生成即自动批准并写入审计；关闭则每一步都等你审批">
						<span className="wb-setting">
							<Switch
								size="small"
								checked={newSession.autoApprove}
								disabled={!canRun}
								onChange={(checked) => setNewSession({ ...newSession, autoApprove: checked })}
							/>
							自动批准
						</span>
					</Tooltip>
				</div>
			)}
			<p className="wb-composer-hint">
				Enter 发送，Shift+Enter 换行。HRouter Agent 只在当前客户项目内操作，每一步都会写入会话记录与审计日志。
			</p>
		</div>
	);

	let main: ReactNode;
	if (!session)
		main = (
			<div className="wb-welcome">
				<Empty
					title="让 HRouter Agent 替你跑完整个流程"
					detail="输入“跑基线”，HRouter Agent 会先和你确认监测问题，然后自动创建批次、等待采集、核验结果、审计官网、生成报告与优化文章。"
				/>
				{composer}
			</div>
		);
	else
		main = (
			<>
				<header className="wb-head">
					<div className="wb-head-title">
						<h3>{session.title}</h3>
						<Tag className={`wb-status ${session.status}`}>{sessionStatusLabel[session.status]}</Tag>
						{session.error_message && <span className="wb-error">{session.error_message}</span>}
					</div>
					<Space size={12} wrap>
						<Tooltip title="草稿生成后不再等待人工点批准；每次自动批准都会写入审计日志">
							<span className="wb-setting">
								<Switch
									size="small"
									checked={session.auto_approve}
									disabled={!canRun}
									onChange={(checked) => void updateSettings({ autoApprove: checked })}
								/>
								自动批准
							</span>
						</Tooltip>
						<span className="wb-setting">
							思考强度
							<Select
								size="small"
								className="wb-thinking"
								value={session.thinking_level ?? "default"}
								disabled={!canRun}
								onChange={(value) => void updateSettings({ thinkingLevel: value === "default" ? null : value })}
								options={[
									{ value: "default", label: "跟随平台设置" },
									...thinkingLevelOptions.map((item) => ({ value: item.value, label: item.label })),
								]}
							/>
						</span>
						<span className="wb-setting">
							模型
							<Select
								size="small"
								className="wb-model-select"
								value={session.model ?? "default"}
								disabled={!canRun}
								popupMatchSelectWidth={false}
								onChange={(value) => void updateSettings({ model: value === "default" ? null : value })}
								options={modelOptions(session.model)}
							/>
						</span>
						{["running", "waiting_user", "waiting_job"].includes(session.status) && (
							<Popconfirm
								title="终止会话？"
								description="正在进行的后台批次不会被取消，但 Agent 不会再继续后续步骤。"
								onConfirm={() =>
									post(`/api/workbench/sessions/${session.id}/cancel`).then(() => loadSession(session.id, false))
								}
							>
								<Button variant="danger" size="small" permission="workbench.run">
									终止
								</Button>
							</Popconfirm>
						)}
					</Space>
				</header>
				<div className="wb-body">
					<div className="wb-stream" ref={scrollRef}>
						{/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Bubble kinds render inline to keep event ordering visible. */}
						{bubbles.map((bubble, index) => {
							const key = `${bubble.seq}-${index}`;
							if (bubble.kind === "user")
								return (
									<div className="wb-bubble user" key={key}>
										<div className="wb-bubble-body">{bubble.text}</div>
									</div>
								);
							if (bubble.kind === "assistant")
								return (
									<div className={`wb-bubble assistant ${bubble.streaming ? "streaming" : ""}`} key={key}>
										<span className="wb-avatar">
											<IconSparkles size={15} />
										</span>
										<div className="wb-bubble-body">
											<FormattedAnswer value={bubble.text || "…"} />
										</div>
									</div>
								);
							if (bubble.kind === "tool") return <ToolBubble bubble={bubble} key={key} />;
							if (bubble.kind === "question")
								return (
									<div className="wb-bubble assistant" key={key}>
										<span className="wb-avatar">
											<IconSparkles size={15} />
										</span>
										<QuestionCard
											bubble={bubble}
											disabled={!canRun || session.status !== "waiting_user"}
											onAnswer={answer}
										/>
									</div>
								);
							return (
								<div className={`wb-system ${bubble.tone}`} key={key}>
									{bubble.tone === "info" ? (
										<IconHourglassHigh size={14} />
									) : bubble.tone === "success" ? (
										<IconCircleCheck size={14} />
									) : (
										<IconCircleX size={14} />
									)}
									<span>{bubble.text}</span>
								</div>
							);
						})}
						{session.status === "running" && bubbles.at(-1)?.kind !== "assistant" && (
							<div className="wb-thinking-indicator">
								<IconLoader2 className="spin" size={14} />
								HRouter Agent 正在思考…
							</div>
						)}
					</div>
					<aside className="wb-side">
						<h4>
							<IconTool size={14} />
							执行进度
						</h4>
						<PlanSteps plan={session.plan} ended={["done", "failed"].includes(session.status)} />
						{!session.plan.length && <p className="wb-side-empty">开始执行后这里会显示每一步的状态。</p>}
						{session.current_batch_id && (
							<div className="wb-side-links">
								<Button variant="link" size="small" onClick={() => navigation.openView("monitor")}>
									查看批次
								</Button>
								<Button variant="link" size="small" onClick={() => navigation.openView("report")}>
									查看报告
								</Button>
								<Button variant="link" size="small" onClick={() => navigation.openView("articles")}>
									优化文章
								</Button>
							</div>
						)}
						{session.usage?.totalTokens ? (
							<p className="wb-usage">本会话已消耗 {session.usage.totalTokens.toLocaleString()} Token</p>
						) : null}
					</aside>
				</div>
				{composer}
			</>
		);

	return (
		<Page
			breadcrumb={project.name}
			eyebrow="AI 工作台"
			title="让 HRouter Agent 跑完整个流程"
			description="一句话下指令，Agent 自动采集、审计、出报告、写文章，全程留痕。"
			className="wb-page"
		>
			<div className="wb-layout">
				{sidebar}
				<section className="wb-main">{main}</section>
			</div>
		</Page>
	);
}
