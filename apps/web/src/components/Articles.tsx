import { IconEye, IconPencil, IconRefresh, IconSparkles, IconTrash } from "@tabler/icons-react";
import { App, Drawer, Form, Input, Popconfirm, Segmented, Select, Table, type TableProps, Tag } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, useAgentRunPolling, usePermission } from "../access";
import { api, patch, post } from "../api";
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
import { FormattedAnswer } from "../ui/markdown";
import { useWorkspaceNavigation } from "../ui/navigation";
import { Empty, FilterBar, IdChip, Pagination, SectionTitle, shortDate } from "../ui/primitives";
import "./Articles.css";
import { Page } from "./Page";

const priorityLabel: Record<string, string> = { high: "高优先级", medium: "中优先级", low: "低优先级" };

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
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const [form] = Form.useForm<{
		title: string;
		summary: string;
		status: ArticleStatus;
		publishedUrl: string;
		contentMarkdown: string;
	}>();
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		const value = await api<Article>(`/api/articles/${articleId}`);
		setArticle(value);
		form.setFieldsValue({
			title: value.title,
			summary: value.summary ?? "",
			status: value.status,
			publishedUrl: value.published_url ?? "",
			contentMarkdown: value.content_markdown,
		});
	}, [articleId, form]);
	useEffect(() => {
		void load().catch((reason) => message.error(reason instanceof Error ? reason.message : "文章加载失败"));
	}, [load, message]);
	// 预览时正文输入框会卸载，preserve 让 useWatch 仍能读到表单里的正文。
	const content = Form.useWatch("contentMarkdown", { form, preserve: true }) ?? "";
	const title = Form.useWatch("title", { form, preserve: true }) ?? "";
	const summary = Form.useWatch("summary", { form, preserve: true }) ?? "";
	async function save() {
		const values = await form.validateFields();
		setBusy(true);
		try {
			await patch(`/api/articles/${articleId}`, {
				title: values.title,
				summary: values.summary || null,
				status: values.status,
				publishedUrl: values.publishedUrl ? values.publishedUrl : null,
				contentMarkdown: values.contentMarkdown,
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
			title={article ? article.title : "加载中"}
			className="article-drawer"
			extra={
				<div className="article-drawer-actions">
					<Segmented
						value={mode}
						onChange={(value) => setMode(value as "edit" | "preview")}
						options={[
							{ value: "edit", label: "编辑", icon: <IconPencil size={14} /> },
							{ value: "preview", label: "预览", icon: <IconEye size={14} /> },
						]}
					/>
					{canWrite && (
						<Button busy={busy} onClick={() => void save()}>
							保存
						</Button>
					)}
				</div>
			}
		>
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
						className={mode === "preview" ? "article-form article-form-hidden" : "article-form"}
						disabled={!canWrite}
					>
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
							extra="支持 ## 小节、列表、表格；保存后正文有变化会生成新版本。"
						>
							<Input.TextArea className="article-textarea" autoSize={{ minRows: 20, maxRows: 40 }} />
						</Form.Item>
					</Form>
					{mode === "preview" && (
						<article className="article-preview">
							<p className="article-preview-kicker">
								{articleStatusLabel[(form.getFieldValue("status") as ArticleStatus) ?? article.status]} · 第{" "}
								{article.version} 版
							</p>
							<h1>{title || article.title}</h1>
							{summary && <p className="article-preview-summary">{summary}</p>}
							<FormattedAnswer value={content || "（正文为空）"} />
						</article>
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
	const [batchId, setBatchId] = useState<string>("all");
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const finishedBatches = useMemo(
		() => project.batches.filter((batch) => ["complete", "partial"].includes(batch.status)),
		[project.batches],
	);
	const load = useCallback(async () => {
		const params = new URLSearchParams({ page: String(page), pageSize: String(DEFAULT_PAGE_SIZE) });
		if (status !== "all") params.set("status", status);
		if (batchId !== "all") params.set("batchId", batchId);
		const [list, runList] = await Promise.all([
			api<Paginated<ArticleSummary>>(`/api/projects/${project.id}/articles?${params}`),
			api<Paginated<AgentRun>>(
				`/api/projects/${project.id}/agent-runs?purposes=optimization_article&pageSize=${DEFAULT_PAGE_SIZE}`,
			),
		]);
		setArticles(list);
		setRuns(runList.items);
	}, [project.id, page, status, batchId]);
	useEffect(() => {
		void load().catch((reason) => message.error(reason instanceof Error ? reason.message : "文章加载失败"));
	}, [load, message]);
	// 文章草稿到 awaiting_approval 后由协调器在后台物化，所以等待批准期间也要继续轮询。
	useAgentRunPolling(runs, load, ["queued", "running", "awaiting_approval"]);
	const generating = runs.filter((run) => ["queued", "running", "awaiting_approval"].includes(run.status));
	async function generate(target: string) {
		setBusy("generate");
		try {
			const result = await post<{ queued: unknown[] }>(`/api/projects/${project.id}/articles/generate`, {
				batchId: target,
			});
			message.success(result.queued.length ? `已排队 ${result.queued.length} 篇文章` : "所有建议都已生成过文章");
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
			width: 260,
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
			title: "状态",
			dataIndex: "status",
			width: 100,
			render: (value: ArticleStatus) => <Tag className={`article-status ${value}`}>{articleStatusLabel[value]}</Tag>,
		},
		{
			title: "字数",
			dataIndex: "content_length",
			width: 90,
			align: "right",
			render: (value: number) => value.toLocaleString(),
		},
		{ title: "更新", dataIndex: "updated_at", width: 130, render: (value: string) => shortDate(value) },
		{
			title: "",
			key: "actions",
			width: 150,
			align: "right",
			render: (_, row) => (
				<div className="article-actions">
					<Button variant="ghost" size="small" icon={<IconPencil size={14} />} onClick={() => setEditing(row.id)}>
						编辑
					</Button>
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
			eyebrow="优化文章"
			title="优化文章"
			description="每条 GEO 建议对应一篇可编辑草稿；发布后填写地址即可复测验收。"
			extra={
				<>
					<Button
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
			{generating.length > 0 && (
				<SectionTitle
					title="正在生成"
					count={generating.length}
					description="Agent 正在基于证据撰写文章，通常每篇 2-5 分钟；完成后自动出现在下方列表。"
				/>
			)}
			<FilterBar>
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
			{articles.total === 0 && !generating.length ? (
				<Empty
					title="还没有优化文章"
					detail="先在复测报告里批准报告叙述，然后从上方选择批次生成文章；或直接让 AI 工作台跑完整个流程。"
				/>
			) : (
				<>
					<Table<ArticleSummary>
						rowKey="id"
						size="middle"
						pagination={false}
						dataSource={articles.items}
						columns={columns}
						className="article-table"
						scroll={{ x: 760 }}
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
