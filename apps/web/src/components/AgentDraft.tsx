import { Collapse, Descriptions, Tag } from "antd";
import type { ReactNode } from "react";
import { Button } from "../access";
import { type AgentRun, agentStatusLabels, type EvidenceIndexEntry } from "../types";
import { FormattedAnswer } from "../ui/markdown";
import { cleanSourceUrl, type EvidenceOpener, EvidenceRef, IdChip } from "../ui/primitives";
import "./AgentDraft.css";

export const agentToolLabels: Record<string, string> = {
	read_project_context: "读取项目",
	read_batch_evidence_index: "建立证据索引",
	read_evidence: "核验原始证据",
	web_search: "联网搜索",
	submit_draft: "校验草稿",
};

const purposeLabels: Record<string, string> = {
	customer_profile: "客户画像",
	prompt_research: "问题研究",
	report_narrative: "报告叙述",
	quality_review: "质量检查",
	diagnosis: "模型诊断",
	remediation: "整改规划",
	content_brief: "内容简报",
	optimization_article: "优化文章",
};

export function agentPurposeLabel(purpose: string): string {
	return purposeLabels[purpose] ?? purpose;
}

export function agentRunPhase(run: AgentRun): string {
	if (run.status === "queued") return run.error_message ?? "等待 Agent Worker 领取任务";
	if (run.status === "awaiting_approval") return "结构化草稿已完成，等待人工审批";
	if (run.status === "approved") return "草稿已批准，可冻结到新的报告版本";
	if (run.status === "rejected") return "草稿已拒绝，不会进入报告版本";
	if (run.status === "failed") return run.error_message ?? "Agent 执行失败";
	const latest = run.tool_trace.at(-1);
	if (!latest) return "正在连接模型并准备分析";
	if (latest.tool === "submit_draft" && latest.type === "end" && latest.isError)
		return "草稿校验未通过，Agent 正在修正后重新提交";
	if (latest.type === "start") return `正在${agentToolLabels[latest.tool] ?? latest.tool}`;
	if (latest.tool === "read_project_context") return "项目范围已确认，正在建立证据索引";
	if (latest.tool === "read_batch_evidence_index") return "证据索引已建立，正在选择支撑证据";
	if (latest.tool === "read_evidence") return "原始证据已读取，正在形成结论";
	if (latest.tool === "web_search")
		return latest.isError ? "一次联网搜索未成功，Agent 正在调整问法或改用本地证据" : "联网搜索完成，正在整理研究结果";
	return "正在整理结构化草稿";
}

export function agentRunDuration(run: AgentRun): string {
	const seconds = Math.max(
		0,
		Math.round((new Date(run.completed_at ?? Date.now()).getTime() - new Date(run.created_at).getTime()) / 1000),
	);
	return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const priorityLabels: Record<string, string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const severityLabels: Record<string, string> = { high: "高", medium: "中", low: "低" };
const reputationLabels: Record<string, string> = {
	positive: "正面为主",
	mixed: "正负混合",
	negative: "负面为主",
	neutral: "中性",
	not_observed: "未观察到口碑",
};

/** 草稿 JSON 字段的中文标签：兜底渲染也不能把英文键名直接给业务用户看。 */
const draftFieldLabels: Record<string, string> = {
	summary: "摘要",
	title: "标题",
	taskId: "关联任务",
	outline: "文章大纲",
	factGaps: "需客户确认的事实",
	evidenceIds: "引用证据",
	draftContent: "正文初稿",
	contentMarkdown: "正文",
	targetPromptIds: "关联问题",
	findings: "诊断发现",
	tasks: "整改任务",
	profile: "客户画像",
	prompts: "问题建议",
	executiveSummary: "管理层叙述",
	reputation: "AI 口碑",
	geoRecommendations: "GEO 优化建议",
	limitations: "证据局限",
	verdict: "检查结论",
	issues: "问题项",
	reviewedNarrativeRunId: "被审核的叙述",
	category: "类别",
	detail: "详情",
	confidence: "置信度",
	recommendation: "整改建议",
	priority: "优先级",
	expectedMetric: "预期指标",
	acceptanceCriteria: "验收标准",
	contentBrief: "内容简报",
	question: "问题",
	intent: "意图",
	tags: "标签",
	statement: "陈述",
	sourceUrls: "来源网址",
	sourceStatus: "来源状态",
	action: "行动",
	rationale: "依据",
	severity: "严重度",
	overall: "整体",
	positiveSignals: "正面信号",
	negativeSignals: "负面信号",
};

const ID_FIELD = /(^id$|Id$|Ids$)/;

type DraftContext = {
	evidenceIndex?: EvidenceIndexEntry[];
	onOpenEvidence?: EvidenceOpener;
	/** 用于把 content_brief 的 taskId 显示成任务标题。 */
	tasks?: Array<{ id: string; title: string }>;
};

type ListItem = Record<string, unknown>;

const asList = (value: unknown): ListItem[] =>
	Array.isArray(value) ? value.filter((item): item is ListItem => typeof item === "object" && item !== null) : [];
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const text = (value: unknown): string => (value == null || value === "" ? "-" : String(value));

function DraftSection({ title, count, children }: { title: string; count?: number | string; children: ReactNode }) {
	return (
		<div>
			<span>
				{title}
				{count !== undefined ? ` · ${count}` : ""}
			</span>
			{children}
		</div>
	);
}

/** 长 Markdown 正文：限定高度内滚动，不让整页被正文撑开。 */
function DraftMarkdown({ value }: { value: string }) {
	return (
		<div className="agent-draft-markdown">
			<FormattedAnswer value={value} />
		</div>
	);
}

/** 字符串列表：证据 ID 走引用芯片，其他 ID 列表走短 ID，普通文本成要点。 */
function DraftStringList({ name, items, context }: { name: string; items: string[]; context: DraftContext }) {
	if (name === "evidenceIds")
		return <EvidenceRef ids={items} index={context.evidenceIndex} onOpen={context.onOpenEvidence} max={4} />;
	if (ID_FIELD.test(name))
		return (
			<span className="agent-draft-ids">
				{items.slice(0, 6).map((id) => (
					<IdChip key={id} value={id} />
				))}
				{items.length > 6 ? <small>等 {items.length} 个</small> : null}
			</span>
		);
	return (
		<ul className="agent-draft-points">
			{items.map((item) => (
				<li key={item}>{item}</li>
			))}
		</ul>
	);
}

/** 兜底渲染的值：字符串成段、字符串列表成要点、ID 列表成证据引用/短 ID、对象只展开一层。 */
function DraftValue({
	name,
	value,
	context,
	depth,
}: {
	name: string;
	value: unknown;
	context: DraftContext;
	depth: number;
}) {
	if (value == null || value === "") return <>-</>;
	if (typeof value === "string")
		return value.length > 400 && depth === 0 ? (
			<DraftMarkdown value={value} />
		) : (
			<p className="agent-draft-text">{value}</p>
		);
	if (typeof value === "number") return <>{name === "confidence" ? `${Math.round(value * 100)}%` : String(value)}</>;
	if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
	if (Array.isArray(value)) {
		if (!value.length) return <>-</>;
		if (value.every((item) => typeof item === "string"))
			return <DraftStringList name={name} items={value.map(String)} context={context} />;
		return (
			<ol className="agent-draft-items">
				{asList(value).map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 草稿是只读快照，条目无稳定 id，顺序即语义
					<li key={index}>
						<DraftObject value={item} context={context} depth={depth + 1} />
					</li>
				))}
			</ol>
		);
	}
	if (typeof value === "object") return <DraftObject value={value as ListItem} context={context} depth={depth + 1} />;
	return <>{String(value)}</>;
}

function DraftObject({ value, context, depth }: { value: ListItem; context: DraftContext; depth: number }) {
	if (depth >= 3) return <p className="agent-draft-text">{Object.values(value).map(text).join("；")}</p>;
	return (
		<Descriptions
			className="agent-draft-descriptions"
			size="small"
			column={1}
			items={Object.entries(value).map(([key, entry]) => ({
				key,
				label: draftFieldLabels[key] ?? key,
				children: <DraftValue name={key} value={entry} context={context} depth={depth} />,
			}))}
		/>
	);
}

/** 审批卡首屏用的概览标签，例如“大纲 11 节 · 事实缺口 7 条 · 证据 15 条”。 */
export function agentDraftStats(run: AgentRun): string[] {
	const draft = run.draft;
	if (!draft) return [];
	const count = (key: string, unit: string, label = draftFieldLabels[key] ?? key) =>
		Array.isArray(draft[key]) && draft[key].length ? `${label} ${draft[key].length} ${unit}` : null;
	const stats: Array<string | null> = [];
	if (run.purpose === "diagnosis") stats.push(count("findings", "条"));
	else if (run.purpose === "remediation") stats.push(count("tasks", "项"));
	else if (run.purpose === "content_brief" || run.purpose === "optimization_article")
		stats.push(count("outline", "节"), count("factGaps", "条"));
	else if (run.purpose === "report_narrative")
		stats.push(count("geoRecommendations", "条"), count("limitations", "条"));
	else if (run.purpose === "quality_review")
		stats.push(
			draft.verdict === "pass" ? "结论 通过" : draft.verdict === "blocked" ? "结论 未通过" : null,
			count("issues", "个"),
		);
	else if (run.purpose === "prompt_research") {
		const prompts = asList(draft.prompts);
		stats.push(
			prompts.length ? `候选问题 ${prompts.length} 个` : null,
			`引用联网/官网证据 ${new Set(prompts.flatMap((item) => asStrings(item.evidenceIds))).size} 条`,
		);
	}
	stats.push(count("evidenceIds", "条", "证据"));
	return stats.filter((item): item is string => item !== null);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Purpose-specific approved schemas intentionally render in one auditable component.
export function AgentDraftContent({
	run,
	evidenceIndex,
	onOpenEvidence,
	tasks,
}: {
	run: AgentRun;
	evidenceIndex?: EvidenceIndexEntry[];
	onOpenEvidence?: EvidenceOpener;
	tasks?: DraftContext["tasks"];
}) {
	const draft = run.draft;
	if (!draft) return null;
	const context: DraftContext = { evidenceIndex, onOpenEvidence, tasks };
	const refs = (ids: unknown, max = 4) =>
		Array.isArray(ids) && ids.length ? (
			<EvidenceRef ids={ids.map(String)} index={evidenceIndex} onOpen={onOpenEvidence} max={max} />
		) : null;
	if (run.purpose === "report_narrative") {
		const limitations = asStrings(draft.limitations);
		const reputation = (draft.reputation ?? {}) as {
			overall?: string;
			summary?: string;
			positiveSignals?: Array<{ statement?: string; sourceUrls?: string[]; evidenceIds?: string[] }>;
			negativeSignals?: Array<{ statement?: string; sourceUrls?: string[]; evidenceIds?: string[] }>;
		};
		const recommendations = asList(draft.geoRecommendations);
		const signals = [
			...(reputation.positiveSignals ?? []).map((signal) => ({ ...signal, polarity: "正面" })),
			...(reputation.negativeSignals ?? []).map((signal) => ({ ...signal, polarity: "负面" })),
		];
		return (
			<div className="agent-draft-content">
				<DraftSection title="报告摘要">
					<p>{text(draft.summary)}</p>
				</DraftSection>
				<DraftSection title="管理层叙述">
					<p>{text(draft.executiveSummary)}</p>
				</DraftSection>
				<div className="agent-reputation-preview">
					<span>AI 口碑 · {reputationLabels[reputation.overall ?? "not_observed"] ?? reputation.overall}</span>
					<p>{reputation.summary ?? "-"}</p>
					{signals.map((signal) => {
						const urls = [...new Set((signal.sourceUrls ?? []).map(cleanSourceUrl))];
						return (
							<div className="reputation-signal" key={`${signal.statement}-${urls.join("|")}`}>
								<Tag className={`reputation-polarity ${signal.polarity === "正面" ? "positive" : "negative"}`}>
									{signal.polarity}
								</Tag>
								<p>
									{signal.statement} {refs(signal.evidenceIds)}
								</p>
								<small>
									来源：
									{urls.length
										? urls.map((url) => (
												<a key={url} href={url} target="_blank" rel="noreferrer">
													{url.replace(/^https?:\/\//, "").slice(0, 60)}
												</a>
											))
										: "平台未开放来源"}
								</small>
							</div>
						);
					})}
				</div>
				{recommendations.length > 0 && (
					<DraftSection title="GEO 优化建议" count={recommendations.length}>
						<ol className="recommendation-list">
							{recommendations.map((item) => (
								<li key={`${item.title}-${item.action}`}>
									<b>
										<Tag>{priorityLabels[String(item.priority)] ?? text(item.priority)}</Tag>
										{text(item.title)}
									</b>
									<p>{text(item.action)}</p>
									{item.rationale ? <small>{String(item.rationale)}</small> : null}
									{refs(item.evidenceIds)}
								</li>
							))}
						</ol>
					</DraftSection>
				)}
				{limitations.length > 0 && (
					<DraftSection title="证据局限" count={limitations.length}>
						<ul>
							{limitations.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</DraftSection>
				)}
			</div>
		);
	}
	if (run.purpose === "quality_review") {
		const issues = asList(draft.issues);
		return (
			<div className="agent-draft-content">
				<DraftSection
					title={`检查结论 · ${draft.verdict === "pass" ? "通过" : draft.verdict === "blocked" ? "未通过" : "-"}`}
				>
					<p>{text(draft.summary)}</p>
				</DraftSection>
				<DraftSection title="问题项" count={issues.length}>
					{issues.length ? (
						<ul>
							{issues.map((issue) => (
								<li key={`${issue.severity}:${issue.detail}`}>
									<Tag>{severityLabels[String(issue.severity)] ?? text(issue.severity)}</Tag>
									{text(issue.detail)} {refs(issue.evidenceIds)}
								</li>
							))}
						</ul>
					) : (
						<p>未发现需要阻止报告交付的问题。</p>
					)}
				</DraftSection>
			</div>
		);
	}
	if (run.purpose === "diagnosis") {
		const findings = asList(draft.findings);
		return (
			<div className="agent-draft-content">
				<DraftSection title="摘要">
					<p>{text(draft.summary)}</p>
				</DraftSection>
				<DraftSection title="诊断发现" count={findings.length}>
					<ol className="recommendation-list">
						{findings.map((finding) => (
							<li key={`${finding.category}-${finding.title}`}>
								<b>
									<Tag>{text(finding.category)}</Tag>
									{text(finding.title)}
									{typeof finding.confidence === "number" && (
										<small className="agent-draft-confidence">置信度 {Math.round(finding.confidence * 100)}%</small>
									)}
								</b>
								<p>{text(finding.detail)}</p>
								<small>整改建议：{text(finding.recommendation)}</small>
								{refs(finding.evidenceIds)}
							</li>
						))}
					</ol>
				</DraftSection>
			</div>
		);
	}
	if (run.purpose === "remediation") {
		const items = asList(draft.tasks);
		return (
			<div className="agent-draft-content">
				<DraftSection title="摘要">
					<p>{text(draft.summary)}</p>
				</DraftSection>
				<DraftSection title="整改任务" count={items.length}>
					<ol className="recommendation-list">
						{items.map((item) => (
							<li key={`${item.title}-${item.expectedMetric}`}>
								<b>
									<Tag>{priorityLabels[String(item.priority)] ?? text(item.priority)}</Tag>
									{text(item.title)}
								</b>
								<p>{text(item.detail)}</p>
								<small>预期指标：{text(item.expectedMetric)}</small>
								<small>验收标准：{text(item.acceptanceCriteria)}</small>
								{refs(item.evidenceIds)}
							</li>
						))}
					</ol>
				</DraftSection>
			</div>
		);
	}
	if (run.purpose === "prompt_research") {
		const prompts = asList(draft.prompts);
		return (
			<div className="agent-draft-content">
				<DraftSection title="研究摘要">
					<p>{text(draft.summary)}</p>
				</DraftSection>
				<DraftSection title="候选问题" count={prompts.length}>
					<ol className="recommendation-list">
						{prompts.map((item) => (
							<li key={`${item.question}`}>
								<b>
									<Tag>{text(item.intent)}</Tag>
									{text(item.question)}
								</b>
								{(item.topic || item.persona || asStrings(item.tags).length > 0) && (
									<small>
										{[item.topic, item.persona, asStrings(item.tags).join("、")]
											.filter(Boolean)
											.map(String)
											.join(" · ")}
									</small>
								)}
								{refs(item.evidenceIds)}
							</li>
						))}
					</ol>
				</DraftSection>
			</div>
		);
	}
	if (run.purpose === "content_brief" || run.purpose === "optimization_article") {
		const outline = asStrings(draft.outline);
		const factGaps = asStrings(draft.factGaps);
		const body = typeof draft.draftContent === "string" ? draft.draftContent : String(draft.contentMarkdown ?? "");
		const taskId = typeof draft.taskId === "string" ? draft.taskId : null;
		const task = taskId ? tasks?.find((item) => item.id === taskId) : undefined;
		return (
			<div className="agent-draft-content">
				<DraftSection title="标题">
					<p className="agent-draft-title">{text(draft.title)}</p>
					{taskId && (
						<p className="agent-draft-meta">
							关联整改任务：{task ? task.title : <IdChip value={taskId} label="任务" />}
						</p>
					)}
				</DraftSection>
				<DraftSection title="摘要">
					<p>{text(draft.summary)}</p>
				</DraftSection>
				{outline.length > 0 && (
					<DraftSection title="文章大纲" count={`${outline.length} 节`}>
						<ol className="agent-draft-points">
							{outline.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ol>
					</DraftSection>
				)}
				{factGaps.length > 0 && (
					<DraftSection title="需客户确认的事实" count={`${factGaps.length} 条`}>
						<ul className="agent-draft-points">
							{factGaps.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</DraftSection>
				)}
				<DraftSection title="引用证据" count={asStrings(draft.evidenceIds).length}>
					{refs(draft.evidenceIds, 6) ?? <p>-</p>}
				</DraftSection>
				{body && (
					<DraftSection title="正文初稿" count={`约 ${body.length.toLocaleString("zh-CN")} 字`}>
						<DraftMarkdown value={body} />
					</DraftSection>
				)}
			</div>
		);
	}
	return <DraftObject value={draft} context={context} depth={0} />;
}

/**
 * Agent 草稿审批卡：首屏只放结论摘要与概览标签，完整草稿收进“查看草稿详情”。
 * 差距诊断与整改中心共用，批准/拒绝由调用方决定请求与刷新。
 */
export function AgentDraftCard({
	run,
	evidenceIndex,
	onOpenEvidence,
	tasks,
	busy = false,
	onApprove,
	onReject,
}: {
	run: AgentRun;
	evidenceIndex?: EvidenceIndexEntry[];
	onOpenEvidence?: EvidenceOpener;
	tasks?: DraftContext["tasks"];
	busy?: boolean;
	onApprove(): void;
	onReject(): void;
}) {
	const label = agentPurposeLabel(run.purpose);
	const pending = run.status === "awaiting_approval";
	const heading = pending
		? `${label}草稿待审批`
		: run.status === "failed"
			? `${label}运行失败`
			: `${label}：${agentStatusLabels[run.status]}`;
	const summary = typeof run.draft?.summary === "string" ? run.draft.summary : null;
	const stats = agentDraftStats(run);
	return (
		<article className={`agent-draft agent-draft-${run.status}`}>
			<div className="agent-draft-main">
				<span className="eyebrow">HRouter Agent · {run.model}</span>
				<h3>{heading}</h3>
				<p className="agent-draft-phase">
					{run.error_message ??
						(["queued", "running"].includes(run.status)
							? "正在分析项目资料，可稍后回来查看。"
							: pending
								? "请核对草稿及引用证据，批准后将写入正式记录。"
								: agentRunPhase(run))}
				</p>
				{summary && <p className="agent-draft-summary">{summary}</p>}
				{stats.length > 0 && (
					<div className="agent-draft-stats">
						{stats.map((item) => (
							<Tag key={item}>{item}</Tag>
						))}
					</div>
				)}
				{run.draft && (
					<Collapse
						className="agent-draft-detail"
						items={[
							{
								key: "draft",
								label: "查看草稿详情",
								children: (
									<AgentDraftContent
										run={run}
										evidenceIndex={evidenceIndex}
										onOpenEvidence={onOpenEvidence}
										tasks={tasks}
									/>
								),
							},
						]}
					/>
				)}
			</div>
			{pending && (
				<div className="agent-draft-actions">
					<Button permission="agent.approve" variant="secondary" busy={busy} onClick={onReject}>
						拒绝
					</Button>
					<Button permission="agent.approve" busy={busy} onClick={onApprove}>
						批准并入库
					</Button>
				</div>
			)}
		</article>
	);
}
