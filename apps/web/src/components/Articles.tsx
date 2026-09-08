import type { PublicationPlan } from "@geo/evidence";
import {
	IconDownload,
	IconEye,
	IconPencil,
	IconRefresh,
	IconShieldCheck,
	IconSparkles,
	IconTrash,
} from "@tabler/icons-react";
import { Alert, App, Drawer, Form, Input, Popconfirm, Segmented, Select, Table, type TableProps, Tag } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, useAgentRunPolling, usePermission } from "../access";
import { api, patch, post } from "../api";
import { useEvidenceIndex } from "../hooks/useEvidenceIndex";
import {
	type AgentRun,
	type Article,
	type ArticleStatus,
	type ArticleSummary,
	articleStatusLabel,
	batchKindLabel,
	DEFAULT_PAGE_SIZE,
	type Paginated,
	type Project,
} from "../types";
import { BrandLoading } from "../ui/BrandLoading";
import { FormattedAnswer } from "../ui/markdown";
import { useWorkspaceNavigation } from "../ui/navigation";
import {
	downloadText,
	Empty,
	EvidenceRef,
	FilterBar,
	IdChip,
	Pagination,
	SectionTitle,
	shortDate,
} from "../ui/primitives";
import "./Articles.css";
import { ArticleQuality, editorialStatusLabel, qualityStatusLabel } from "./ArticleQuality";
import { Page } from "./Page";
import { PublicationPlanFields, PublicationPlanView } from "./PublicationPlan";

const priorityLabel: Record<string, string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const publicationStatusLabel: Record<string, string> = {
	unplanned: "未安排",
	draft: "工单草稿",
	ready: "待发布",
	in_progress: "执行中",
	submitted: "待验收",
	verified: "已发布",
	failed: "发布失败",
	cancelled: "已取消",
	outcome_unknown: "结果待确认",
};

function ArticleTargetQuestions({ article }: { article: Article }) {
	return article.target_questions?.length ? (
		article.target_questions.map((question) => <p key={question.id}>{question.question}</p>)
	) : (
		<p>未关联具体监测问题。</p>
	);
}

function ArticleLoadState({ ready, error, onRetry }: { ready: boolean; error: string | null; onRetry(): void }) {
	if (ready) return null;
	if (!error) return <BrandLoading label="正在读取文章" />;
	return (
		<Alert
			showIcon
			type="error"
			title={error}
			action={
				<Button variant="link" onClick={onRetry}>
					重新加载
				</Button>
			}
		/>
	);
}

function ArticleEditor({
	articleId,
	canWrite,
	onClose,
	onSaved,
}: {
	articleId: string;
	canWrite: boolean;
	onClose(): void;
	onSaved(): Promise<void>;
}) {
	const { message } = App.useApp();
	const [article, setArticle] = useState<Article | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const evidenceIndex = useEvidenceIndex(article?.batch_id, article?.project_id);
	const [mode, setMode] = useState<"edit" | "preview" | "quality">(canWrite ? "edit" : "preview");
	const [form] = Form.useForm<{
		title: string;
		summary: string;
		status: ArticleStatus;
		publishedUrl: string;
		contentMarkdown: string;
		publicationPlan?: PublicationPlan;
	}>();
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		setLoadError(null);
		const value = await api<Article>(`/api/articles/${articleId}`);
		setArticle(value);
		form.setFieldsValue({
			title: value.title,
			summary: value.summary ?? "",
			status: value.status,
			publishedUrl: value.published_url ?? "",
			contentMarkdown: value.content_markdown,
			publicationPlan: value.publication_plan ?? undefined,
		});
	}, [articleId, form]);
	const reload = useCallback(() => {
		void load().catch((reason) => setLoadError(reason instanceof Error ? reason.message : "文章加载失败"));
	}, [load]);
	useEffect(reload, [reload]);
	// 预览时正文输入框会卸载，preserve 让 useWatch 仍能读到表单里的正文。
	const content = Form.useWatch("contentMarkdown", { form, preserve: true }) ?? "";
	const title = Form.useWatch("title", { form, preserve: true }) ?? "";
	const summary = Form.useWatch("summary", { form, preserve: true }) ?? "";
	const publicationPlan = Form.useWatch("publicationPlan", { form, preserve: true });
	async function save() {
		let values: Awaited<ReturnType<typeof form.validateFields>>;
		try {
			values = await form.validateFields();
		} catch {
			setMode("edit");
			message.warning("请补全标出的必填项后保存。");
			return;
		}
		setBusy(true);
		try {
			await patch(`/api/articles/${articleId}`, {
				version: article?.version,
				title: values.title,
				summary: values.summary || null,
				status: values.status,
				publishedUrl: values.publishedUrl ? values.publishedUrl : null,
				contentMarkdown: values.contentMarkdown,
				publicationPlan: values.publicationPlan
					? {
							...values.publicationPlan,
							channels: values.publicationPlan.channels.map((channel, index) => ({
								...channel,
								evidenceIds: form.getFieldValue(["publicationPlan", "channels", index, "evidenceIds"]) ?? [],
							})),
						}
					: undefined,
			});
			message.success("已保存");
			await Promise.all([load(), onSaved()]);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}
	const wordCount = content.replace(/\s+/g, "").length;
	return (
		<Drawer
			open
			size={Math.min(1120, window.innerWidth - 32)}
			onClose={onClose}
			title={article ? article.title : "文章详情"}
			className="article-drawer"
			rootClassName="article-drawer-root"
			extra={
				<div className="article-drawer-actions">
					<Segmented
						value={mode}
						onChange={(value) => setMode(value as "edit" | "preview" | "quality")}
						options={[
							{ value: "edit", label: "编辑", disabled: !canWrite, icon: <IconPencil size={14} /> },
							{ value: "preview", label: "预览", icon: <IconEye size={14} /> },
							{ value: "quality", label: "审核质检", icon: <IconShieldCheck size={14} /> },
						]}
					/>
					{canWrite && (
						<Button busy={busy} disabled={!article} onClick={() => void save()}>
							保存
						</Button>
					)}
				</div>
			}
		>
			<ArticleLoadState ready={Boolean(article)} error={loadError} onRetry={reload} />
			{article && (
				<div className="article-editor">
					<aside className="article-editor-side">
						<h4>来源建议</h4>
						<p className="article-source-title">
							{article.recommendation_priority && (
								<Tag>{priorityLabel[article.recommendation_priority] ?? article.recommendation_priority}</Tag>
							)}
							{article.recommendation_title}
						</p>
						{article.recommendation_action && <p className="article-source-action">{article.recommendation_action}</p>}
						<h4>关联监测问题</h4>
						<ArticleTargetQuestions article={article} />
						<h4>参考证据</h4>
						<EvidenceRef ids={article.evidence_ids} index={evidenceIndex} />
						{article.outline.length > 0 && (
							<>
								<h4>文章结构</h4>
								<ol className="article-outline">
									{article.outline.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ol>
							</>
						)}
						{article.fact_gaps.length > 0 && (
							<>
								<h4>需客户补充</h4>
								<ul className="article-gaps">
									{article.fact_gaps.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ul>
							</>
						)}
						<h4>版本</h4>
						<p className="article-meta">
							第 {article.version} 版 · 更新于 {shortDate(article.updated_at)} · {wordCount.toLocaleString()} 字
						</p>
						<IdChip value={article.id} label="文章" />
					</aside>
					<Form
						form={form}
						layout="vertical"
						className={mode !== "edit" ? "article-form article-form-hidden" : "article-form"}
						disabled={!canWrite}
					>
						<PublicationPlanFields />
						<div className="article-form-grid">
							<Form.Item name="title" label="标题" rules={[{ required: true, min: 2, max: 120 }]}>
								<Input />
							</Form.Item>
							<Form.Item name="status" label="状态">
								<Select
									options={(Object.keys(articleStatusLabel) as ArticleStatus[]).map((value) => ({
										value,
										label: articleStatusLabel[value],
									}))}
								/>
							</Form.Item>
							<Form.Item name="publishedUrl" label="发布地址" rules={[{ type: "url", message: "请输入完整 URL" }]}>
								<Input placeholder="https://" />
							</Form.Item>
						</div>
						<Form.Item name="summary" label="摘要">
							<Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={600} showCount />
						</Form.Item>
						<Form.Item
							name="contentMarkdown"
							label="正文（Markdown）"
							rules={[{ required: true, message: "正文不能为空" }]}
						>
							<Input.TextArea className="article-textarea" autoSize={{ minRows: 20, maxRows: 40 }} />
						</Form.Item>
					</Form>
					{mode === "preview" && (
						<article className="article-preview">
							<PublicationPlanView plan={publicationPlan ?? article.publication_plan} />
							<p className="article-preview-kicker">
								{articleStatusLabel[(form.getFieldValue("status") as ArticleStatus) ?? article.status]} · 第{" "}
								{article.version} 版
							</p>
							<h1>{title || article.title}</h1>
							{summary && <p className="article-preview-summary">{summary}</p>}
							<FormattedAnswer value={content || "（正文为空）"} />
						</article>
					)}
					{mode === "quality" && (
						<ArticleQuality
							article={article}
							onChanged={async () => {
								await Promise.all([load(), onSaved()]);
							}}
						/>
					)}
				</div>
			)}
		</Drawer>
	);
}

export function Articles({ project }: { project: Project }) {
	const { message } = App.useApp();
	const navigation = useWorkspaceNavigation();
	const canWrite = usePermission("articles.manage");
	const [articles, setArticles] = useState<Paginated<ArticleSummary>>({
		items: [],
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 1,
	});
	const [page, setPage] = useState(1);
	const [status, setStatus] = useState<string>("all");
	const [qualityStatus, setQualityStatus] = useState("all");
	const [publicationStatus, setPublicationStatus] = useState("all");
	const [reviewStatus, setReviewStatus] = useState("all");
	const [search, setSearch] = useState("");
	const [selection, setSelection] = useState<React.Key[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [batchId, setBatchId] = useState<string>("all");
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	useEffect(() => {
		const [kind, value] = (navigation.viewFilter ?? "").split(":");
		setQualityStatus(kind === "quality" ? value : "all");
		setReviewStatus(kind === "review" ? (value === "pending" ? "unapproved" : value) : "all");
		setPage(1);
	}, [navigation.viewFilter]);
	const finishedBatches = useMemo(
		() => project.batches.filter((batch) => ["complete", "partial"].includes(batch.status)),
		[project.batches],
	);
	const load = useCallback(async () => {
		setLoading(true);
		try {
			const params = new URLSearchParams({ page: String(page), pageSize: String(DEFAULT_PAGE_SIZE) });
			if (status !== "all") params.set("status", status);
			if (qualityStatus !== "all") params.set("qualityStatus", qualityStatus);
			if (publicationStatus !== "all") params.set("publicationStatus", publicationStatus);
			if (reviewStatus !== "all") params.set("reviewStatus", reviewStatus);
			if (search) params.set("search", search);
			if (batchId !== "all") params.set("batchId", batchId);
			const [list, runList] = await Promise.all([
				api<Paginated<ArticleSummary>>(`/api/projects/${project.id}/articles?${params}`),
				api<Paginated<AgentRun>>(
					`/api/projects/${project.id}/agent-runs?purposes=optimization_article&pageSize=${DEFAULT_PAGE_SIZE}`,
				),
			]);
			setArticles(list);
			if (list.page > list.totalPages) setPage(list.totalPages);
			setRuns(runList.items);
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "文章加载失败");
		} finally {
			setLoading(false);
		}
	}, [project.id, page, status, batchId, qualityStatus, reviewStatus, publicationStatus, search]);
	useEffect(() => {
		void load().catch((reason) => message.error(reason instanceof Error ? reason.message : "文章加载失败"));
	}, [load, message]);
	// 文章草稿到 awaiting_approval 后由协调器在后台物化，所以等待批准期间也要继续轮询。
	useAgentRunPolling(runs, load, ["queued", "running", "awaiting_approval"]);
	const generating = runs.filter((run) => ["queued", "running", "awaiting_approval"].includes(run.status));
	async function generate(target: string) {
		setBusy("generate");
		try {
			const result = await post<{ queued: unknown[]; skipped?: Array<{ title: string; reason: string }> }>(
				`/api/projects/${project.id}/articles/generate`,
				{
					batchId: target,
				},
			);
			if (result.skipped?.length)
				message.info(
					`已排队 ${result.queued.length} 篇内容文章；${result.skipped.length} 条非内容或未分类建议未转成文章。${result.skipped[0].reason}`,
				);
			else message.success(result.queued.length ? `已排队 ${result.queued.length} 篇文章` : "内容建议都已生成过文章");
			await load();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "生成失败");
		} finally {
			setBusy(null);
		}
	}
	const columns: TableProps<ArticleSummary>["columns"] = [
		{
			title: "文章",
			dataIndex: "title",
			render: (_, row) => (
				<div className="article-cell">
					<button type="button" className="article-title" onClick={() => setEditing(row.id)}>
						{row.title}
					</button>
					{row.summary && <span className="article-summary">{row.summary}</span>}
				</div>
			),
		},
		{
			title: "来源建议",
			dataIndex: "recommendation_title",
			width: 200,
			render: (value: string, row) => (
				<div className="article-cell">
					<span>{value}</span>
					<small>
						{row.recommendation_priority
							? (priorityLabel[row.recommendation_priority] ?? row.recommendation_priority)
							: ""}
						{row.batch_id &&
							` · ${batchKindLabel(project.batches.find((batch) => batch.id === row.batch_id)?.kind ?? "baseline")}`}
					</small>
				</div>
			),
		},
		{
			title: "发布",
			dataIndex: "publication_status",
			width: 100,
			render: (value: string) => (
				<Tag
					color={
						value === "verified"
							? "success"
							: value === "failed"
								? "error"
								: value === "outcome_unknown"
									? "warning"
									: undefined
					}
				>
					{publicationStatusLabel[value ?? "unplanned"] ?? value}
				</Tag>
			),
		},
		{
			title: "内容审核",
			dataIndex: "review_status",
			width: 100,
			render: (value?: string) => (
				<Tag color={value === "approved" ? "success" : value === "rejected" ? "error" : undefined}>
					{editorialStatusLabel[value ?? "pending"]}
				</Tag>
			),
		},
		{
			title: "文章质检",
			dataIndex: "quality_status",
			width: 100,
			render: (value?: string) => (
				<Tag
					color={
						value === "passed"
							? "success"
							: value === "failed"
								? "error"
								: value === "needs_review" || value === "stale"
									? "warning"
									: undefined
					}
				>
					{qualityStatusLabel[value ?? "pending"]}
				</Tag>
			),
		},
		{
			title: "字数",
			dataIndex: "content_length",
			width: 70,
			align: "right",
			render: (value: number) => value.toLocaleString(),
		},
		{ title: "更新", dataIndex: "updated_at", width: 120, render: (value: string) => shortDate(value) },
		{
			title: "",
			key: "actions",
			width: 110,
			fixed: "right",
			align: "right",
			render: (_, row) => (
				<div className="article-actions">
					<Button
						variant="ghost"
						size="small"
						icon={canWrite ? <IconPencil size={14} /> : <IconEye size={14} />}
						title={canWrite ? "编辑文章" : "查看文章"}
						aria-label={canWrite ? "编辑文章" : "查看文章"}
						onClick={() => setEditing(row.id)}
					/>
					<Button
						variant="ghost"
						size="small"
						permission="articles.manage"
						icon={<IconRefresh size={14} />}
						title="按同一条建议重新生成，完成后覆盖为新版本"
						aria-label="重新生成"
						busy={busy === `regen-${row.id}`}
						onClick={async () => {
							setBusy(`regen-${row.id}`);
							try {
								await post(`/api/articles/${row.id}/regenerate`);
								message.success("已重新排队生成，完成后会覆盖为新版本");
								await load();
							} catch (reason) {
								message.error(reason instanceof Error ? reason.message : "操作失败");
							} finally {
								setBusy(null);
							}
						}}
					/>
					<Popconfirm
						title="删除这篇文章？"
						onConfirm={async () => {
							await api(`/api/articles/${row.id}`, { method: "DELETE" });
							await load();
						}}
					>
						<Button
							variant="danger"
							size="small"
							permission="articles.manage"
							icon={<IconTrash size={14} />}
							title="删除文章"
							aria-label="删除文章"
						/>
					</Popconfirm>
				</div>
			),
		},
	];
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="内容中心"
			title="文章管理"
			extra={
				<>
					<Button
						variant="secondary"
						icon={<IconDownload size={16} />}
						disabled={!selection.length}
						busy={busy === "export"}
						onClick={async () => {
							setBusy("export");
							try {
								const params = new URLSearchParams();
								for (const id of selection) params.append("articleId", String(id));
								const result = await api<{ files: Array<{ title: string; version: number; content: string }> }>(
									`/api/projects/${project.id}/articles/export?${params}`,
								);
								downloadText(
									`articles-${new Date().toISOString().slice(0, 10)}.md`,
									result.files.map((file) => file.content).join("\n\n---\n\n"),
									"text/markdown;charset=utf-8",
								);
								message.success(`已导出 ${result.files.length} 篇文章`);
							} catch (reason) {
								message.error(reason instanceof Error ? reason.message : "导出失败");
							} finally {
								setBusy(null);
							}
						}}
					>
						批量导出{selection.length ? ` (${selection.length})` : ""}
					</Button>
					<Button
						permission="workbench.run"
						variant="secondary"
						icon={<IconSparkles size={16} />}
						onClick={() => navigation.openWorkbench("基于最近一份已批准报告的 GEO 建议逐条生成优化文章。")}
					>
						交给 AI 工作台
					</Button>
					{canWrite && finishedBatches.length > 0 && (
						<Select
							className="article-generate"
							placeholder="从报告生成文章"
							value={null}
							loading={busy === "generate"}
							onChange={(value) => {
								if (value) void generate(String(value));
							}}
							popupMatchSelectWidth={false}
							options={finishedBatches.map((batch) => ({
								value: batch.id,
								label: `${batchKindLabel(batch.kind)} · ${shortDate(batch.created_at)}`,
							}))}
						/>
					)}
				</>
			}
		>
			{error && (
				<Alert
					type="error"
					title={error}
					action={
						<Button variant="link" onClick={() => void load()}>
							重试
						</Button>
					}
				/>
			)}
			{generating.length > 0 && (
				<SectionTitle
					title="正在生成"
					count={generating.length}
					description="Agent 正在基于证据撰写文章，通常每篇 2-5 分钟；完成后自动出现在下方列表。"
				/>
			)}
			<FilterBar>
				<Input.Search
					allowClear
					placeholder="搜索标题或摘要"
					className="article-search"
					onSearch={(value) => {
						setSearch(value.trim());
						setPage(1);
					}}
				/>
				<Segmented
					value={status}
					onChange={(value) => {
						setStatus(String(value));
						setPage(1);
					}}
					options={[
						{ value: "all", label: "全部" },
						...(Object.keys(articleStatusLabel) as ArticleStatus[]).map((value) => ({
							value,
							label: articleStatusLabel[value],
						})),
					]}
				/>
				<Select
					aria-label="文章发布状态"
					value={publicationStatus}
					onChange={(value) => {
						setPublicationStatus(value);
						setPage(1);
					}}
					options={[
						{ value: "all", label: "全部发布状态" },
						...Object.entries(publicationStatusLabel).map(([value, label]) => ({ value, label })),
					]}
				/>
				<Select
					aria-label="内容审核状态"
					value={reviewStatus}
					onChange={(value) => {
						setReviewStatus(value);
						setPage(1);
					}}
					options={[
						{ value: "all", label: "全部审核状态" },
						{ value: "unapproved", label: "待审核或修改" },
						...Object.entries(editorialStatusLabel).map(([value, label]) => ({ value, label })),
					]}
				/>
				<Select
					aria-label="文章质检状态"
					value={qualityStatus}
					onChange={(value) => {
						setQualityStatus(value);
						setPage(1);
					}}
					options={[
						{ value: "all", label: "全部质检状态" },
						...Object.entries(qualityStatusLabel).map(([value, label]) => ({ value, label })),
					]}
				/>
				<Select
					value={batchId}
					onChange={(value) => {
						setBatchId(value);
						setPage(1);
					}}
					popupMatchSelectWidth={false}
					options={[
						{ value: "all", label: "全部批次" },
						...project.batches.map((batch) => ({
							value: batch.id,
							label: `${batchKindLabel(batch.kind)} · ${shortDate(batch.created_at)}`,
						})),
					]}
				/>
			</FilterBar>
			{articles.total === 0 && !generating.length && !loading ? (
				<Empty
					title="还没有优化文章"
					detail="先在复测报告里批准报告叙述，然后从上方选择批次生成文章；或直接让 AI 工作台跑完整个流程。"
				/>
			) : (
				<>
					<Table<ArticleSummary>
						loading={loading}
						rowSelection={{
							selectedRowKeys: selection,
							onChange: (keys) => setSelection(keys),
							preserveSelectedRowKeys: true,
						}}
						rowKey="id"
						size="middle"
						pagination={false}
						dataSource={articles.items}
						columns={columns}
						className="article-table"
						scroll={{ x: 1050 }}
					/>
					<Pagination
						page={articles.page}
						pageSize={articles.pageSize}
						total={articles.total}
						totalPages={articles.totalPages}
						onPage={setPage}
					/>
				</>
			)}
			{editing && (
				<ArticleEditor articleId={editing} canWrite={canWrite} onClose={() => setEditing(null)} onSaved={load} />
			)}
		</Page>
	);
}
