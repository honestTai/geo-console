import {
	IconArrowUp,
	IconCheck,
	IconCircleCheck,
	IconCircleX,
	IconExternalLink,
	IconHourglassHigh,
	IconLoader2,
	IconPlus,
	IconSparkles,
	IconTool,
	IconWorldSearch,
} from "@tabler/icons-react";
import { App, Checkbox, Input, Popconfirm, Radio, Select, Space, Steps, Switch, Tag, Tooltip } from "antd";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, patch, post } from "../api";
import {
	type AgentSessionPlanStep,
	type AgentSessionStatus,
	type Paginated,
	type Project,
	type ScopeProposal,
	sessionStatusLabel,
	thinkingLevelOptions,
	type WebSearchTestStatus,
	type WorkbenchEvent,
	type WorkbenchQuickCommand,
	type WorkbenchSession,
} from "../types";
import { FormattedAnswer } from "../ui/markdown";
import { useWorkspaceNavigation } from "../ui/navigation";
import { cleanSourceUrl, Empty, shortDate, sourceHost } from "../ui/primitives";
import { Page } from "./Page";
import { type ScopeProposalAnswer, ScopeProposalCard } from "./ScopeProposalCard";
import "./Workbench.css";

type SessionList = Paginated<WorkbenchSession> & { quickCommands: WorkbenchQuickCommand[] };
type SessionUpdates = { items: WorkbenchEvent[]; lastSeq: number; session: WorkbenchSession };
const isDesktopAgentClient = () => navigator.userAgent.includes("ZZGeoDesktop/");

const toolLabels: Record<string, string> = {
	read_project_context: "读取客户项目",
	read_batch_evidence_index: "读取证据索引",
	read_evidence: "读取证据",
	web_search: "联网搜索",
	suggest_questions: "整理问题候选",
	ask_user: "向你提问",
	propose_questions: "提交问题候选",
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
			return `现有 ${Array.isArray(value.current) ? value.current.length : 0} 个问题 · 建档候选 ${Array.isArray(value.pendingCandidates) ? value.pendingCandidates.length : 0} 个 · 知识库候选 ${Array.isArray(value.libraryCandidates) ? value.libraryCandidates.length : 0} 个`;
		case "propose_questions":
			return `等待你确认 ${value.questionCount ?? "?"} 个候选问题`;
		default:
			return null;
	}
}

type Bubble =
	| { kind: "user"; seq: number; text: string; at: string }
	| { kind: "assistant"; seq: number; text: string; at: string; streaming: boolean }
	| {
			kind: "tool";
			seq: number;
			toolCallId: string | null;
			tool: string;
			status: "running" | "done" | "error";
			detail: string | null;
			/** tool_start 带的调用参数；联网搜索在执行中就能显示正在检索的问题。 */
			args: Record<string, unknown> | null;
			/** tool_end 的结构化结果；只有联网搜索会按结构渲染，其余工具用 detail 一句话。 */
			details: unknown;
			at: string;
	  }
	| {
			kind: "question";
			seq: number;
			question: string;
			options: string[];
			multiple: boolean;
			at: string;
			answered: boolean;
	  }
	| {
			kind: "proposal";
			seq: number;
			proposal: ScopeProposal;
			at: string;
			answered: boolean;
			answeredText: string | null;
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
				const text = String(payload.text ?? "");
				for (const bubble of bubbles) {
					if (bubble.kind === "question") bubble.answered = true;
					if (bubble.kind === "proposal" && !bubble.answered) {
						bubble.answered = true;
						bubble.answeredText = event.type === "user_answer" ? text : null;
					}
				}
				// 候选确认的结果已经显示在卡片里，不再重复一条用户气泡。
				if (event.type === "user_answer" && payload.applied !== undefined) break;
				bubbles.push({ kind: "user", seq: event.seq, text, at });
				break;
			}
			case "proposal":
				bubbles.push({
					kind: "proposal",
					seq: event.seq,
					proposal: {
						intro: String(payload.intro ?? ""),
						questions: Array.isArray(payload.questions) ? (payload.questions as ScopeProposal["questions"]) : [],
						competitors: Array.isArray(payload.competitors)
							? (payload.competitors as ScopeProposal["competitors"])
							: [],
						industry: typeof payload.industry === "string" ? payload.industry : null,
						evidence: Array.isArray(payload.evidence) ? (payload.evidence as ScopeProposal["evidence"]) : [],
					},
					at,
					answered: false,
					answeredText: null,
				});
				break;
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
				bubbles.push({
					kind: "tool",
					seq: event.seq,
					toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
					tool: String(payload.tool),
					status: "running",
					detail: null,
					args: payload.args && typeof payload.args === "object" ? (payload.args as Record<string, unknown>) : null,
					details: null,
					at,
				});
				break;
			case "tool_update": {
				const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
				const open = [...bubbles]
					.reverse()
					.find(
						(item) =>
							item.kind === "tool" &&
							item.status === "running" &&
							(toolCallId ? item.toolCallId === toolCallId : item.tool === String(payload.tool)),
					);
				if (open?.kind === "tool") open.details = payload.details ?? null;
				break;
			}
			case "tool_end": {
				const tool = String(payload.tool);
				const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
				const open = [...bubbles]
					.reverse()
					.find(
						(item) =>
							item.kind === "tool" &&
							item.status === "running" &&
							(toolCallId ? item.toolCallId === toolCallId : item.tool === tool),
					);
				const detail = payload.isError
					? String(payload.details ?? "工具执行失败")
					: describeToolEnd(tool, payload.details);
				const details = payload.isError ? null : (payload.details ?? null);
				if (open && open.kind === "tool") {
					open.status = payload.isError ? "error" : "done";
					open.detail = detail;
					open.details = details;
				} else
					bubbles.push({
						kind: "tool",
						seq: event.seq,
						toolCallId,
						tool,
						status: payload.isError ? "error" : "done",
						detail,
						args: null,
						details,
						at,
					});
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
			case "step":
				if (payload.key === "scope" && payload.status === "done")
					bubbles.push({
						kind: "system",
						seq: event.seq,
						tone: "success",
						text: `监测范围已写入：${String(payload.detail ?? "")}`,
						at,
					});
				break;
			default:
				break;
		}
	}
	return bubbles;
}

/** 会话选中的模型（或平台默认模型）在联网搜索测试里的状态；未测试过为 null。 */
function webSearchModelState(
	status: WebSearchTestStatus | null,
	model: string | null,
): { model: string | null; state: "ok" | "failed" | "untested" } {
	const resolved = model ?? status?.defaultModel ?? null;
	const test = resolved ? status?.tests[resolved] : undefined;
	return { model: resolved, state: test ? test.status : "untested" };
}

const modelSuffix: Record<"ok" | "failed" | "untested", string> = {
	ok: "",
	failed: " · 联网测试失败",
	untested: " · 联网未验证",
};

type StepsStatus = "wait" | "process" | "finish" | "error";

const EVIDENCE_UUID_REF = /\[([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/gi;

/** Agent 偶尔把证据 UUID 原样写进回复；展示时缩成“[证据 2cd12b7e]”，完整 ID 仍留在会话记录与审计日志里。 */
export function humanizeEvidenceRefs(text: string): string {
	return text.replace(EVIDENCE_UUID_REF, "[证据 $1]");
}

/**
 * 计划步骤 → antd Steps 状态。会话结束后尚未跑完的步骤不再转圈：会话失败/终止时按失败标记；
 * 会话正常完成时这些步骤（如仍在后台生成的优化文章）显示为进行中，等协调器把它们收尾。
 */
function planStepStatus(step: AgentSessionPlanStep, sessionStatus: AgentSessionStatus): StepsStatus {
	if (step.status === "done") return "finish";
	if (step.status === "failed") return "error";
	if (step.status !== "running") return "wait";
	return sessionStatus === "failed" ? "error" : "process";
}

function PlanSteps({ plan, sessionStatus }: { plan: AgentSessionPlanStep[]; sessionStatus: AgentSessionStatus }) {
	if (!plan.length) return null;
	const ended = ["done", "failed"].includes(sessionStatus);
	return (
		<Steps
			className="wb-plan"
			size="small"
			orientation="vertical"
			items={plan.map((step) => {
				const running = step.status === "running" && !ended;
				const background = step.status === "running" && sessionStatus === "done";
				const detail = step.detail ?? undefined;
				return {
					title: step.label,
					content: background ? [detail, "后台进行中"].filter(Boolean).join(" · ") : detail,
					status: planStepStatus(step, sessionStatus),
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
				<FormattedAnswer value={humanizeEvidenceRefs(bubble.question)} />
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
	return (
		<div className={`wb-tool ${bubble.status}`}>
			<span className="wb-tool-icon">{statusIcon(bubble.status)}</span>
			<span className="wb-tool-name">{toolLabels[bubble.tool] ?? bubble.tool}</span>
			{bubble.detail && <span className="wb-tool-detail">{bubble.detail}</span>}
		</div>
	);
}

type ToolBubbleData = Extract<Bubble, { kind: "tool" }>;
type StreamRow = Bubble | { kind: "search"; seq: number; items: ToolBubbleData[] };

/** 连续的几次联网搜索合成一张“检索过程”卡；中间隔着回复或别的工具就另起一张。 */
function groupSearches(bubbles: Bubble[]): StreamRow[] {
	const rows: StreamRow[] = [];
	for (const bubble of bubbles) {
		const last = rows.at(-1);
		if (bubble.kind !== "tool" || bubble.tool !== "web_search") rows.push(bubble);
		else if (last?.kind === "search") last.items.push(bubble);
		else rows.push({ kind: "search", seq: bubble.seq, items: [bubble] });
	}
	return rows;
}

type SearchSource = { url: string; title: string | null };
type SearchDetails = {
	evidenceId: string | null;
	query: string | null;
	searchQueries: string[];
	sources: SearchSource[];
	unavailable: boolean;
	reason: string | null;
	phase: string | null;
};

/** tool_end 里的联网搜索结果；旧会话的事件可能已被整体截断，此时只能显示 tool_start 里的检索问题。 */
function readSearchDetails(details: unknown): SearchDetails | null {
	if (!details || typeof details !== "object") return null;
	const value = details as Record<string, unknown>;
	if (value.truncated) return null;
	const sources = Array.isArray(value.sources) ? value.sources : [];
	return {
		evidenceId: typeof value.evidenceId === "string" ? value.evidenceId : null,
		query: typeof value.query === "string" ? value.query : null,
		searchQueries: Array.isArray(value.searchQueries)
			? value.searchQueries.filter((item): item is string => typeof item === "string")
			: [],
		sources: sources.flatMap((source) => {
			const record = source as { url?: unknown; title?: unknown } | null;
			return typeof record?.url === "string"
				? [{ url: record.url, title: typeof record.title === "string" && record.title ? record.title : null }]
				: [];
		}),
		unavailable: value.unavailable === true,
		reason: typeof value.reason === "string" ? value.reason : null,
		phase: typeof value.phase === "string" ? value.phase : null,
	};
}

const SOURCE_PREVIEW = 5;

function statusIcon(status: ToolBubbleData["status"], size = 15) {
	if (status === "running") return <IconLoader2 className="spin" size={size} />;
	if (status === "error") return <IconCircleX size={size} />;
	return <IconCircleCheck size={size} />;
}

/** 联网不可用是工具的非错误结果，但对用户来说这次搜索没成功，按失败样式显示。 */
function searchItemStatus(item: ToolBubbleData): ToolBubbleData["status"] {
	return readSearchDetails(item.details)?.unavailable ? "error" : item.status;
}

const RAW_UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** 来源超链接列表：默认只放前几条，其余折叠，避免几十个链接把对话流淹没。 */
function SourceList({ sources }: { sources: SearchSource[] }) {
	const [expanded, setExpanded] = useState(false);
	if (!sources.length) return null;
	const visible = expanded ? sources : sources.slice(0, SOURCE_PREVIEW);
	return (
		<>
			<ol className="wb-search-sources">
				{visible.map((source) => (
					<li key={source.url}>
						<a
							className="wb-search-source"
							href={cleanSourceUrl(source.url)}
							target="_blank"
							rel="noreferrer"
							title={cleanSourceUrl(source.url)}
						>
							<IconExternalLink size={13} />
							<span className="wb-search-source-title">{source.title ?? cleanSourceUrl(source.url)}</span>
							<span className="wb-search-source-host">{sourceHost(source.url)}</span>
						</a>
					</li>
				))}
			</ol>
			{sources.length > SOURCE_PREVIEW && (
				<Button variant="link" size="small" className="wb-search-more" onClick={() => setExpanded(!expanded)}>
					{expanded ? "收起来源" : `还有 ${sources.length - SOURCE_PREVIEW} 个来源`}
				</Button>
			)}
		</>
	);
}

/** 一次联网搜索：检索问题、可跳转的证据 ID、Agent 声明的目的、模型实际发出的检索词与来源超链接。 */
function SearchItem({ item, onOpenEvidence }: { item: ToolBubbleData; onOpenEvidence(evidenceId: string): void }) {
	const details = readSearchDetails(item.details);
	const status = searchItemStatus(item);
	const query = details?.query ?? (typeof item.args?.query === "string" ? item.args.query : "");
	const purpose = typeof item.args?.purpose === "string" ? item.args.purpose : null;
	const evidenceId = details?.evidenceId ?? null;
	const sources = details?.sources ?? [];
	// 检索词与提问完全相同时不再重复一行。
	const terms = (details?.searchQueries ?? []).filter((term) => term !== query);
	// 失败原因里带的记录 UUID 缩成前 8 位，与回复里的“[证据 xxxxxxxx]”对得上。
	const failure = item.status === "error" ? item.detail : details?.unavailable ? details.reason : null;
	return (
		<li className={`wb-search-item ${status}`}>
			<div className="wb-search-query">
				<span className="wb-tool-icon">{statusIcon(status)}</span>
				<strong>{query ? `「${query}」` : "联网搜索"}</strong>
				{evidenceId && (
					<Tooltip title="在证据中心查看这条联网搜索的归纳全文与来源">
						<button type="button" className="wb-search-evidence" onClick={() => onOpenEvidence(evidenceId)}>
							证据 {evidenceId.slice(0, 8)}
						</button>
					</Tooltip>
				)}
				{item.status === "running" && (
					<span className="wb-search-state">{details?.phase === "recording" ? "保存证据中…" : "搜索中…"}</span>
				)}
			</div>
			{purpose && <p className="wb-search-purpose">{purpose}</p>}
			{details?.unavailable && <p className="wb-search-note error">联网搜索不可用，已改用官网快照与知识库</p>}
			{failure && <p className="wb-search-note error">{failure.replace(RAW_UUID, "$1")}</p>}
			{terms.length > 0 && (
				<div className="wb-search-terms">
					<span className="wb-search-terms-label">实际检索词</span>
					{terms.map((term) => (
						<span className="wb-search-term" key={term}>
							{term}
						</span>
					))}
				</div>
			)}
			<SourceList sources={sources} />
			{status === "done" && details && !sources.length && (
				<p className="wb-search-note">搜索已完成，但模型没有标注来源网址；归纳文本可在证据中心查看。</p>
			)}
		</li>
	);
}

/** 联网搜索卡：像 Codex 那样把每次检索、检索词与来源链接按顺序列出来，而不是只报一个来源数。 */
function SearchCard({ items, onOpenEvidence }: { items: ToolBubbleData[]; onOpenEvidence(evidenceId: string): void }) {
	const running = items.some((item) => item.status === "running");
	const failed = !running && items.every((item) => searchItemStatus(item) === "error");
	const sourceCount = new Set(items.flatMap((item) => readSearchDetails(item.details)?.sources.map((s) => s.url) ?? []))
		.size;
	const summary = [
		items.length > 1 ? `${items.length} 次搜索` : null,
		sourceCount ? `${sourceCount} 个来源` : running ? "搜索中…" : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<section className={`wb-search ${running ? "running" : failed ? "error" : "done"}`}>
			<header className="wb-search-head">
				<span className="wb-tool-icon">
					<IconWorldSearch size={15} />
				</span>
				<span className="wb-tool-name">联网搜索</span>
				{summary && <span className="wb-tool-detail">{summary}</span>}
			</header>
			<ol className="wb-search-list">
				{items.map((item) => (
					<SearchItem item={item} onOpenEvidence={onOpenEvidence} key={item.seq} />
				))}
			</ol>
		</section>
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
	const [localEvents, setLocalEvents] = useState<WorkbenchEvent[]>([]);
	const [draft, setDraft] = useState(initialMessage ?? "");
	const [busy, setBusy] = useState(false);
	const [models, setModels] = useState<string[]>([]);
	const [webSearchStatus, setWebSearchStatus] = useState<WebSearchTestStatus | null>(null);
	const [testingModel, setTestingModel] = useState<string | null>(null);
	const [newSession, setNewSession] = useState<{
		model: string | null;
		thinkingLevel: string | null;
		autoApprove: boolean;
		webSearchEnabled: boolean;
	}>({
		model: null,
		thinkingLevel: null,
		autoApprove: true,
		webSearchEnabled: true,
	});
	const lastSeq = useRef(0);
	const activeSessionId = useRef<string | null>(activeId);
	const lastDesktopAttempt = useRef<string | null>(null);
	activeSessionId.current = activeId;
	const scrollRef = useRef<HTMLDivElement>(null);
	const loadSessions = useCallback(async () => {
		const result = await api<SessionList>(`/api/projects/${project.id}/workbench/sessions?pageSize=50`);
		setSessions(result.items);
		setQuickCommands(result.quickCommands ?? []);
		return result.items;
	}, [project.id]);
	const loadSession = useCallback(async (id: string, reset: boolean, waitMs = 0, signal?: AbortSignal) => {
		const page = await api<SessionUpdates>(
			`/api/workbench/sessions/${id}/events?after=${reset ? 0 : lastSeq.current}&wait=${waitMs}`,
			{ signal },
		);
		if (activeSessionId.current !== id) return page;
		setSession(page.session);
		if (page.items.length) {
			lastSeq.current = page.lastSeq;
			setEvents((current) => (reset ? page.items : [...current, ...page.items]));
		} else if (reset) setEvents([]);
		return page;
	}, []);
	useEffect(() => {
		void loadSessions()
			.then((items) => {
				if (!activeId && items[0] && !initialMessage) setActiveId(items[0].id);
			})
			.catch((reason) => message.error(reason instanceof Error ? reason.message : "会话加载失败"));
	}, [loadSessions, message, activeId, initialMessage]);
	const loadWebSearchStatus = useCallback(async () => {
		// 按模型记住的联网搜索测试结果；读不到时不阻塞工作台，只是不显示提示。
		try {
			setWebSearchStatus(await api<WebSearchTestStatus>("/api/settings/hrouter/web-search-status"));
		} catch {
			setWebSearchStatus(null);
		}
	}, []);
	useEffect(() => {
		// 模型列表只用于下拉选择；读取失败时仍可用平台设置里的默认模型。
		api<{ models: Array<{ id: string }> }>("/api/settings/hrouter/models")
			.then((result) => setModels(result.models.map((item) => item.id)))
			.catch(() => setModels([]));
		void loadWebSearchStatus();
	}, [loadWebSearchStatus]);
	useEffect(() => {
		// 桌面端空闲时预加载本地 Agent，避免首个新会话再等待运行时解析。
		if (isDesktopAgentClient()) void import("../desktop-agent");
	}, []);
	async function testWebSearchModel(model: string | null) {
		const target = model ?? webSearchStatus?.defaultModel ?? null;
		setTestingModel(target ?? "default");
		try {
			const result = await post<{ searchTriggered: boolean; model: string; message: string | null }>(
				"/api/settings/hrouter/test-web-search",
				{ model: target },
			);
			if (result.searchTriggered) message.success(`${result.model} 联网搜索可用`);
			else message.error(`${result.model} 未触发联网搜索${result.message ? `：${result.message}` : ""}`);
			await loadWebSearchStatus();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "联网搜索测试失败");
		} finally {
			setTestingModel(null);
		}
	}
	useEffect(() => {
		if (!activeId) {
			setSession(null);
			setEvents([]);
			setLocalEvents([]);
			return;
		}
		lastSeq.current = 0;
		setSession((current) => (current?.id === activeId ? current : null));
		setEvents([]);
		setLocalEvents([]);
		void (async () => {
			try {
				let page = await loadSession(activeId, true);
				while (
					page.items.length >= 500 &&
					!["running", "waiting_job"].includes(page.session.status) &&
					activeSessionId.current === activeId
				)
					page = await loadSession(activeId, false);
			} catch (reason) {
				message.error(reason instanceof Error ? reason.message : "会话加载失败");
			}
		})();
	}, [activeId, loadSession, message]);
	const polling = session ? ["running", "waiting_job"].includes(session.status) : false;
	useEffect(() => {
		if (!activeId || !polling) return;
		const controller = new AbortController();
		void (async () => {
			while (!controller.signal.aborted) {
				try {
					const updated = await loadSession(activeId, false, 20_000, controller.signal);
					if (!["running", "waiting_job"].includes(updated.session.status) && updated.items.length < 500) break;
				} catch {
					if (controller.signal.aborted) break;
					await new Promise((resolve) => window.setTimeout(resolve, 1_000));
				}
			}
		})();
		return () => controller.abort();
	}, [activeId, polling, loadSession]);
	useEffect(() => {
		if (
			!isDesktopAgentClient() ||
			!activeId ||
			!session ||
			session.execution_target !== "desktop" ||
			session.status !== "running"
		)
			return;
		const attemptKey = `${activeId}:${session.desktop_pending_trigger ?? ""}:${session.desktop_turn_start_index ?? -1}`;
		if (lastDesktopAttempt.current === attemptKey) return;
		lastDesktopAttempt.current = attemptKey;
		void import("../desktop-agent").then(({ startDesktopAgent }) =>
			startDesktopAgent(activeId, {
				onEvent: (event) => {
					if (activeSessionId.current !== activeId) return;
					setLocalEvents((current) => {
						const id = event.payload.clientEventId;
						if (current.some((item) => item.payload.clientEventId === id)) return current;
						const retained =
							event.type === "assistant_message"
								? current.filter(
										(item) =>
											item.type !== "assistant_delta" || Number(item.payload.turn) !== Number(event.payload.turn),
									)
								: current;
						return [...retained, event];
					});
				},
				onSession: (updated) => {
					if (activeSessionId.current !== activeId) return;
					setSession(updated);
					void loadSession(activeId, false).catch(() => undefined);
				},
				onError: (error) => {
					if (activeSessionId.current !== activeId) return;
					message.error(error.message);
					void loadSession(activeId, false).catch(() => undefined);
				},
			}),
		);
	}, [activeId, session, loadSession, message]);
	useEffect(() => {
		if (session && ["done", "failed", "waiting_user", "idle"].includes(session.status)) {
			void loadSessions().catch(() => undefined);
			void refresh().catch(() => undefined);
		}
	}, [session?.status, session, loadSessions, refresh]);
	// Agent 创建批次后立即刷新项目，项目总览/AI 监测拿到的批次列表才包含它。
	const currentBatchId = session?.current_batch_id ?? null;
	useEffect(() => {
		if (currentBatchId) void refresh().catch(() => undefined);
	}, [currentBatchId, refresh]);
	const visibleEvents = useMemo(() => {
		const persistedIds = new Set(events.map((event) => event.payload.clientEventId).filter(Boolean));
		return [...events, ...localEvents.filter((event) => !persistedIds.has(event.payload.clientEventId))];
	}, [events, localEvents]);
	const bubbles = useMemo(() => foldEvents(visibleEvents), [visibleEvents]);
	const rows = useMemo(() => groupSearches(bubbles), [bubbles]);
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
				webSearchEnabled: newSession.webSearchEnabled,
				executionTarget: isDesktopAgentClient() ? "desktop" : "server",
			});
			setDraft("");
			onConsumeInitial();
			setActiveId(created.id);
			void loadSessions().catch(() => undefined);
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
	/** 候选问题表格的确认/不采用：确认由服务端直接写入监测范围，失败原因原样提示。 */
	async function answerProposal(body: ScopeProposalAnswer | { answer: string }) {
		if (!activeId) return;
		try {
			const result = await post<{ applied?: boolean; promptCount?: number; libraryAdded?: number }>(
				`/api/workbench/sessions/${activeId}/answer`,
				body,
			);
			if (result.applied)
				message.success(
					`已写入 ${result.promptCount ?? 0} 个监测问题${result.libraryAdded ? `，知识库新增 ${result.libraryAdded} 条` : ""}`,
				);
			await loadSession(activeId, false);
			await refresh();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "提交失败");
			throw reason;
		}
	}
	async function updateSettings(values: {
		autoApprove?: boolean;
		thinkingLevel?: string | null;
		model?: string | null;
		webSearchEnabled?: boolean;
	}) {
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
		{
			value: "default",
			label: `跟随平台设置${webSearchStatus?.defaultModel ? modelSuffix[webSearchModelState(webSearchStatus, null).state] : ""}`,
		},
		...[...new Set([...models, ...(current && !models.includes(current) ? [current] : [])])].map((id) => ({
			value: id,
			label: `${id}${modelSuffix[webSearchModelState(webSearchStatus, id).state]}`,
		})),
	];
	/** 联网开着但所选模型没通过联网测试时给一句提示，并允许当场测试该模型。 */
	const webSearchHint = (enabled: boolean, model: string | null) => {
		if (!enabled || !webSearchStatus) return null;
		const state = webSearchModelState(webSearchStatus, model);
		if (state.state === "ok" || !state.model) return null;
		return (
			<span className="wb-model-hint">
				{state.state === "failed"
					? `${state.model} 联网搜索测试失败，出题将只能用本地证据`
					: `${state.model} 尚未验证联网搜索`}
				<Button
					variant="link"
					size="small"
					permission="workbench.run"
					busy={testingModel === (state.model ?? "default")}
					onClick={() => void testWebSearchModel(model)}
				>
					测试此模型
				</Button>
			</span>
		);
	};
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
					<Tooltip title="开启后自动批准普通草稿并写审计；报告叙述和质检仍须人工审批">
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
					<Tooltip title="关闭后 Agent 不会联网搜索，出题只用官网快照与知识库；每次联网搜索都计入 HRouter 费用">
						<span className="wb-setting">
							<Switch
								size="small"
								checked={newSession.webSearchEnabled}
								disabled={!canRun}
								onChange={(checked) => setNewSession({ ...newSession, webSearchEnabled: checked })}
							/>
							联网搜索
						</span>
					</Tooltip>
					{webSearchHint(newSession.webSearchEnabled, newSession.model)}
				</div>
			)}
			<p className="wb-composer-hint">AI 生成内容需核对，模型调用按用量计费。</p>
		</div>
	);

	let main: ReactNode;
	if (!session)
		main = (
			<div className="wb-welcome">
				<Empty title="开始新对话" detail="还没有对话记录。" />
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
						{session.execution_target === "desktop" && <Tag>桌面执行</Tag>}
					</div>
					<Space className="wb-head-settings" size={12} wrap>
						<Tooltip title="普通草稿可自动批准并写入审计；报告叙述和质检不会绕过人工审批">
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
						<Tooltip title="关闭后下一回合起 Agent 不再联网搜索；每次联网搜索都计入 HRouter 费用">
							<span className="wb-setting">
								<Switch
									size="small"
									checked={session.web_search_enabled}
									disabled={!canRun}
									onChange={(checked) => void updateSettings({ webSearchEnabled: checked })}
								/>
								联网搜索
							</span>
						</Tooltip>
						{webSearchHint(session.web_search_enabled, session.model)}
						{["running", "waiting_user", "waiting_job"].includes(session.status) && (
							<Popconfirm
								title="终止会话？"
								description="正在进行的后台批次不会被取消，但 Agent 不会再继续后续步骤。"
								onConfirm={() =>
									import("../desktop-agent")
										.then(({ abortDesktopAgent }) => abortDesktopAgent(session.id))
										.then(() => post(`/api/workbench/sessions/${session.id}/cancel`))
										.then(() => loadSession(session.id, false))
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
						{rows.map((bubble, index) => {
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
											<FormattedAnswer value={humanizeEvidenceRefs(bubble.text || "…")} />
										</div>
									</div>
								);
							if (bubble.kind === "search")
								return (
									<SearchCard
										items={bubble.items}
										onOpenEvidence={(id) => navigation.openEvidence(id, session.current_batch_id, "web_search")}
										key={key}
									/>
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
							if (bubble.kind === "proposal")
								return (
									<div className="wb-bubble assistant wb-bubble-wide" key={key}>
										<span className="wb-avatar">
											<IconSparkles size={15} />
										</span>
										<ScopeProposalCard
											proposal={bubble.proposal}
											answered={bubble.answered}
											answeredText={bubble.answeredText}
											disabled={!canRun || session.status !== "waiting_user"}
											onOpenEvidence={(id, kind) => navigation.openEvidence(id, session.current_batch_id, kind)}
											onConfirm={answerProposal}
											onReject={(reason) => answerProposal({ answer: reason })}
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
						<PlanSteps plan={session.plan} sessionStatus={session.status} />
						{!session.plan.length && <p className="wb-side-empty">开始执行后这里会显示每一步的状态。</p>}
						{session.current_batch_id && (
							<div className="wb-side-links">
								<Button
									variant="link"
									size="small"
									onClick={() => session.current_batch_id && navigation.openBatch(session.current_batch_id)}
								>
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
		<Page breadcrumb={project.name} eyebrow="AI 工作台" title="AI 工作台" className="wb-page">
			<div className="wb-layout">
				{sidebar}
				<section className="wb-main">{main}</section>
			</div>
		</Page>
	);
}
