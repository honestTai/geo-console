import {
	IconCheck,
	IconClipboardCheck,
	IconSearch,
	IconSparkles,
	IconWorldSearch,
	IconWorldWww,
} from "@tabler/icons-react";
import { Alert, App, Checkbox, Steps, Tag, Tooltip } from "antd";
import { useEffect, useState } from "react";
import { Button, useAgentRunPolling, usePermission } from "../access";
import { api, post } from "../api";
import { useEvidenceIndex } from "../hooks/useEvidenceIndex";
import { usePaginated } from "../hooks/usePagination";
import {
	type AgentRun,
	type Competitor,
	competitorVerificationLabel,
	isCompetitorVerificationPending,
	type Paginated,
	type Project,
	type Prompt,
} from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { SectionTitle } from "../ui/primitives";
import { AgentDraftCard } from "./AgentDraft";
import { type EditableField, EditableList } from "./EditableList";
import "./Onboarding.css";
import { Page } from "./Page";

/** 与工作台“帮我出监测问题”快捷指令一致：把出题交给会联网研究的 Agent。 */
const QUESTION_RESEARCH_MESSAGE =
	"我不确定该监测哪些问题。请联网研究这个行业的买家会怎样向 AI 搜索提问，给我出一批监测问题候选并和我确认。";

const STEPS = [{ title: "抓取官网" }, { title: "人工确认" }, { title: "建立基线" }];

const COMPETITOR_FIELDS: EditableField<Competitor>[] = [
	{ key: "name", label: "竞品名称", width: 150 },
	{ key: "domain", label: "竞品域名", placeholder: "example.com", width: 190 },
];

const PROMPT_FIELDS: EditableField<Prompt>[] = [
	{ key: "question", label: "监测问题", width: 280 },
	{ key: "intent", label: "意图", width: 110 },
	{ key: "topic", label: "主题", width: 120 },
	{ key: "persona", label: "购买者角色", width: 130 },
];

type ConfirmResult = { confirmed: boolean; libraryAdded?: number; libraryLinked?: number };

/** 建档分析后的竞品联网核实标签：只有“已联网核实”不需要成员额外留意；“联网核实中”会随项目轮询自动更新。 */
function CompetitorVerificationTag({ competitor }: { competitor: Competitor }) {
	const verification = competitor.verification ?? null;
	if (!verification && !competitor.id) return null;
	const pending = isCompetitorVerificationPending(verification);
	return (
		<Tooltip
			title={
				pending
					? "建档请求已返回，联网核实在后台进行，结果会自动更新"
					: (verification?.note ?? "建档分析时未联网核实（HRouter 未配置或联网不可用）")
			}
		>
			<Tag
				className={
					verification?.status === "confirmed" ? "verify-tag ok" : pending ? "verify-tag pending" : "verify-tag"
				}
			>
				{competitorVerificationLabel(verification)}
			</Tag>
		</Tooltip>
	);
}

/** 后台核实期间轮询项目的间隔。 */
const VERIFICATION_POLL_MS = 3_000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 建档页同时承载官网分析、后台出题草稿审批、手工编辑与确认，集中在一个视图便于成员一屏完成。
export function Onboarding({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const navigation = useWorkspaceNavigation();
	const { message } = App.useApp();
	const canWriteKnowledge = usePermission("knowledge.manage");
	const [busy, setBusy] = useState<"analyze" | "confirm" | "research" | string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [manualReview, setManualReview] = useState(false);
	const [syncLibrary, setSyncLibrary] = useState(false);
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState<Competitor[]>(project.competitors ?? []);
	const [prompts, setPrompts] = useState<Prompt[]>(project.prompts ?? []);
	useEffect(() => {
		setAliases(project.aliases ?? []);
		setCompetitors(project.competitors ?? []);
		setPrompts(project.prompts ?? []);
	}, [project]);
	const researchRuns = usePaginated<AgentRun>(
		(page, pageSize) => {
			const params = new URLSearchParams({
				page: String(page),
				pageSize: String(pageSize),
				purposes: "prompt_research",
			});
			return api<Paginated<AgentRun>>(`/api/projects/${project.id}/agent-runs?${params}`);
		},
		[project.id],
	);
	useAgentRunPolling(researchRuns.items, researchRuns.reload);
	// 竞品核实在建档请求返回后仍在后台进行：有候选处于“核实中”时只拉取核实结论并按域名合并进本地列表，
	// 不整页 refresh——否则每次轮询都会把成员正在编辑的竞品/问题重置回服务端值。超时后按未核实展示并停止。
	const verifying = competitors.some((competitor) => isCompetitorVerificationPending(competitor.verification));
	useEffect(() => {
		if (!verifying) return;
		let cancelled = false;
		const timer = window.setInterval(() => {
			void api<Project>(`/api/projects/${project.id}`)
				.then((latest) => {
					if (cancelled) return;
					const byDomain = new Map(
						(latest.competitors ?? []).map((competitor) => [competitor.domain, competitor.verification ?? null]),
					);
					setCompetitors((current) =>
						current.map((competitor) => {
							const verification = byDomain.get(competitor.domain);
							return verification && verification.status !== "pending" ? { ...competitor, verification } : competitor;
						}),
					);
				})
				.catch(() => undefined);
		}, VERIFICATION_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [verifying, project.id]);
	const evidenceIndex = useEvidenceIndex(null, project.id);
	const activeResearch = researchRuns.items.filter((run) =>
		["queued", "running", "awaiting_approval", "failed"].includes(run.status),
	);
	async function analyze() {
		setBusy("analyze");
		setError(null);
		try {
			const result = await post<{
				reusedSnapshots?: boolean;
				competitorVerification?: { status: "pending" | "none"; candidates: number };
			}>(`/api/projects/${project.id}/analyze`);
			await refresh();
			const verification = result.competitorVerification;
			const source = result.reusedSnapshots ? "（复用了 24 小时内的官网快照）" : "";
			message.success(
				verification?.status === "pending"
					? `官网分析完成${source}：${verification.candidates} 个竞品候选正在后台联网核实，结果会自动更新`
					: `官网分析完成${source}`,
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "分析失败");
		} finally {
			setBusy(null);
		}
	}
	async function research() {
		setBusy("research");
		setError(null);
		try {
			await post(`/api/projects/${project.id}/agent`, { purpose: "prompt_research" });
			await researchRuns.reload();
			message.success("已在后台开始联网出题，草稿生成后在这里审批");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "后台出题失败");
		} finally {
			setBusy(null);
		}
	}
	async function decide(runId: string, decision: "approve" | "reject") {
		setBusy(runId);
		setError(null);
		try {
			await post(`/api/agent-runs/${runId}/${decision}`);
			await researchRuns.reload();
			if (decision === "approve") {
				await refresh();
				setManualReview(true);
				message.success("候选问题已加入下方列表，核对后确认启用");
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	async function confirm() {
		setBusy("confirm");
		setError(null);
		try {
			const result = await post<ConfirmResult>(`/api/projects/${project.id}/confirm`, {
				aliases,
				competitors,
				prompts,
				syncLibrary: syncLibrary && canWriteKnowledge && Boolean(project.industry),
			});
			await refresh();
			if (result.libraryAdded) message.success(`项目已启用，${result.libraryAdded} 个新问题已写入行业知识库`);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "确认失败");
		} finally {
			setBusy(null);
		}
	}
	const researchButton = (
		<Tooltip title="HRouter Agent 在后台联网研究买家问法并生成候选草稿；批准后进入下方问题列表，仍由你确认">
			<span>
				<Button
					permission="project.onboard"
					variant="secondary"
					busy={busy === "research"}
					disabled={activeResearch.some((run) => run.status === "queued" || run.status === "running")}
					icon={<IconWorldWww size={17} />}
					onClick={research}
				>
					后台联网出题
				</Button>
			</span>
		</Tooltip>
	);
	const workbenchButton = (
		<Button
			permission="workbench.run"
			variant="secondary"
			icon={<IconSparkles size={17} />}
			onClick={() => navigation.openWorkbench(QUESTION_RESEARCH_MESSAGE)}
		>
			和 Agent 一起出题
		</Button>
	);
	const researchDrafts = activeResearch.length > 0 && (
		<>
			<SectionTitle
				title="后台出题草稿"
				count={researchRuns.total}
				description="批准后候选进入问题列表（不会直接启用项目）；拒绝则丢弃。"
			/>
			<div className="agent-draft-list">
				{activeResearch.map((run) => (
					<AgentDraftCard
						key={run.id}
						run={run}
						evidenceIndex={evidenceIndex}
						onOpenEvidence={(id, kind) => navigation.openEvidence(id, null, kind)}
						busy={busy === run.id}
						onReject={() => void decide(run.id, "reject")}
						onApprove={() => void decide(run.id, "approve")}
					/>
				))}
			</div>
		</>
	);
	const hasCandidates = (project.prompts?.length ?? 0) > 0 || (project.competitors?.length ?? 0) > 0;
	if (project.status === "draft" && !manualReview && !hasCandidates)
		return (
			<Page
				className="onboarding"
				breadcrumb={project.name}
				eyebrow="客户建档"
				title="读取客户官网"
				description="建档分三步：抓取官网 → 人工确认监测范围 → 建立基线。"
			>
				<Steps size="small" current={0} items={STEPS} className="onboarding-steps" />
				<div className="action-panel">
					<IconWorldSearch size={34} />
					<h2>读取客户的真实官网</h2>
					<p>
						抓取官网页面，由 HRouter Agent
						生成客户画像、竞品候选与购买问题，并联网核实竞品、合并同行业知识库。需先在平台设置配好 HRouter Agent。
					</p>
					{error && <Alert type="error" showIcon title={error} />}
					<div className="actions">
						<Button
							permission="project.onboard"
							busy={busy === "analyze"}
							icon={<IconSearch size={17} />}
							onClick={analyze}
						>
							{busy === "analyze" ? "正在抓取和分析" : "开始官网分析"}
						</Button>
						{researchButton}
						{workbenchButton}
						<Button
							permission="project.onboard"
							variant="secondary"
							icon={<IconClipboardCheck size={17} />}
							onClick={() => setManualReview(true)}
						>
							手工配置监测范围
						</Button>
					</div>
				</div>
				{researchDrafts}
			</Page>
		);
	const librarySwitch = canWriteKnowledge && (
		<Tooltip
			title={
				project.industry
					? "只写入没有知识库引用的新问题；同行业客户建档时自动复用"
					: "客户未填写行业，无法归入行业知识库"
			}
		>
			<Checkbox
				className="onboarding-sync"
				checked={syncLibrary && Boolean(project.industry)}
				disabled={!project.industry}
				onChange={(event) => setSyncLibrary(event.target.checked)}
			>
				新问题同步写入{project.industry ? `「${project.industry}」` : "行业"}知识库
			</Checkbox>
		</Tooltip>
	);
	return (
		<Page
			className="onboarding"
			breadcrumb={project.name}
			eyebrow="客户建档"
			title="审核监测范围"
			description={
				manualReview && !hasCandidates
					? "直接填写真实品牌别名、竞品和购买问题。确认前不会创建采集任务。"
					: "删除不真实的竞品（“待确认”表示联网核实未通过），修改问题后再确认。确认前不会创建采集任务。"
			}
			extra={
				<div className="actions">
					{researchButton}
					{workbenchButton}
					<Button
						permission="project.onboard"
						busy={busy === "confirm"}
						icon={<IconCheck size={17} />}
						onClick={confirm}
					>
						确认并启用项目
					</Button>
				</div>
			}
		>
			<Steps size="small" current={1} items={STEPS} className="onboarding-steps" />
			{error && <Alert type="error" showIcon title={error} />}
			{researchDrafts}
			<EditableList joined title="品牌别名" items={aliases} onChange={setAliases} placeholder="多个别名用逗号分隔" />
			<EditableList
				title="竞品候选"
				description="域名用于识别引用来源；建档分析会联网核实域名与行业，未通过的标为“待确认”。"
				items={competitors}
				onChange={setCompetitors}
				fields={COMPETITOR_FIELDS}
				makeNew={() => ({ name: "", domain: "", aliases: [] })}
				extra={(competitor) => <CompetitorVerificationTag competitor={competitor} />}
				empty={<p className="muted">当前没有竞品候选，可以添加后再确认。</p>}
			/>
			<EditableList
				title="购买问题"
				items={prompts}
				onChange={setPrompts}
				fields={PROMPT_FIELDS}
				makeNew={() => ({ question: "", intent: "购买决策", topic: "", persona: "", tags: [] })}
				indexed
			/>
			{librarySwitch}
		</Page>
	);
}
