import type { ArticleQualityView } from "@geo/evidence";
import { IconCheck, IconRefresh, IconShieldCheck, IconX } from "@tabler/icons-react";
import { Alert, App, Descriptions, Form, Input, Modal, Select, Skeleton, Table, Tag } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post } from "../api";
import type { Article } from "../types";
import { Empty, shortDate } from "../ui/primitives";
import "./ArticleQuality.css";

export const qualityStatusLabel: Record<string, string> = {
	pending: "待质检",
	running: "检查中",
	failed: "检查失败",
	needs_review: "待复核",
	passed: "已通过",
	stale: "已过期",
};
export const editorialStatusLabel: Record<string, string> = {
	pending: "待审核",
	approved: "已通过",
	rejected: "已退回",
	stale: "待重新审核",
};
const statusColor: Record<string, string> = {
	failed: "error",
	passed: "success",
	approved: "success",
	rejected: "error",
	running: "processing",
	needs_review: "warning",
	stale: "warning",
};
const categoryLabel: Record<string, string> = {
	factual: "事实准确性",
	evidence: "证据依据",
	completeness: "内容完整性",
	readability: "文字表达",
	publication: "发布要求",
};
const fieldLabel: Record<string, string> = {
	title: "标题",
	summary: "摘要",
	contentMarkdown: "正文",
	publicationPlan: "发布计划",
};

export function ArticleQuality({ article, onChanged }: { article: Article; onChanged(): Promise<void> }) {
	const { message } = App.useApp();
	const canKnowledge = usePermission("page.customer_knowledge");
	const [view, setView] = useState<ArticleQualityView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [knowledge, setKnowledge] = useState<
		Array<{ id: string; title: string; current_revision: number; revision_id: string; expired: boolean }>
	>([]);
	const [knowledgeIds, setKnowledgeIds] = useState<string[]>([]);
	const [review, setReview] = useState<{ kind: "quality" | "editorial"; decision: "approve" | "reject" } | null>(null);
	const [form] = Form.useForm<{ note: string }>();
	const load = useCallback(async () => {
		try {
			setView(await api<ArticleQualityView>(`/api/articles/${article.id}/quality`));
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "文章质检加载失败");
		}
	}, [article.id]);
	useEffect(() => {
		if (article.version < 1) return;
		void load();
	}, [load, article.version]);
	useEffect(() => {
		if (!canKnowledge) return;
		const controller = new AbortController();
		void api<{ items: typeof knowledge }>(
			`/api/projects/${article.project_id}/knowledge-assets?pageSize=100&status=approved`,
			{ signal: controller.signal },
		)
			.then((value) => setKnowledge(value.items.filter((item) => !item.expired)))
			.catch(() => undefined);
		return () => controller.abort();
	}, [article.project_id, canKnowledge]);
	const active = view?.runs.some((run) => ["pending", "running"].includes(run.status));
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => void load(), 2500);
		return () => window.clearInterval(timer);
	}, [active, load]);
	async function runQuality() {
		setBusy(true);
		try {
			await post(`/api/articles/${article.id}/quality`, {
				version: article.version,
				knowledgeRevisionIds: knowledgeIds,
			});
			setSelectedId(null);
			await load();
			message.success("文章质检已排队");
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "质检排队失败");
		} finally {
			setBusy(false);
		}
	}
	const run = view?.runs.find((item) => item.id === selectedId) ?? view?.runs[0];
	async function submitReview() {
		const values = await form.validateFields();
		if (!review) return;
		setBusy(true);
		try {
			await post(
				review.kind === "quality" ? `/api/article-quality/${run?.id}/review` : `/api/articles/${article.id}/review`,
				{ version: article.version, decision: review.decision, note: values.note },
			);
			setReview(null);
			form.resetFields();
			await Promise.all([load(), onChanged()]);
			message.success("审核意见已记录");
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "审核失败");
		} finally {
			setBusy(false);
		}
	}
	const currentRun = run?.id === view?.runs[0]?.id && run?.version === article.version && run?.status !== "stale";
	const canApproveResult =
		currentRun &&
		run?.status === "needs_review" &&
		run.result?.verdict === "pass" &&
		!run.validation.length &&
		!run.result.issues.some((issue) => issue.severity === "blocking");
	return (
		<section className="article-quality">
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
			{!view && !error && <Skeleton active />}
			{view && (
				<>
					<div className="article-quality-heading">
						<h3>当前版本审校</h3>
						<Tag>第 {article.version} 版</Tag>
					</div>
					<div className="article-quality-statuses">
						<span>
							内容审核 <Tag color={statusColor[view.editorialStatus]}>{editorialStatusLabel[view.editorialStatus]}</Tag>
						</span>
						<span>
							文章质检 <Tag color={statusColor[view.qualityStatus]}>{qualityStatusLabel[view.qualityStatus]}</Tag>
						</span>
					</div>
					<div className="article-quality-toolbar">
						<Button
							permission="articles.review"
							variant="secondary"
							icon={<IconCheck size={16} />}
							onClick={() => setReview({ kind: "editorial", decision: "approve" })}
						>
							审核通过
						</Button>
						<Button
							permission="articles.review"
							variant="secondary"
							icon={<IconX size={16} />}
							onClick={() => setReview({ kind: "editorial", decision: "reject" })}
						>
							退回修改
						</Button>
					</div>
					{canKnowledge && (
						<Form layout="vertical">
							<Form.Item label="核对资料">
								<Select
									mode="multiple"
									value={knowledgeIds}
									onChange={setKnowledgeIds}
									placeholder="选择客户知识版本"
									optionFilterProp="label"
									options={knowledge.map((item) => ({
										value: item.revision_id,
										label: `${item.title} · 第 ${item.current_revision} 版`,
									}))}
								/>
							</Form.Item>
						</Form>
					)}
					<div className="article-quality-toolbar">
						<Button
							permission="articles.quality.run"
							busy={busy}
							disabled={Boolean(active)}
							icon={<IconShieldCheck size={16} />}
							onClick={() => void runQuality()}
						>
							{" "}
							{view.runs.length ? "重新质检" : "开始质检"}
						</Button>
						<Button
							variant="ghost"
							icon={<IconRefresh size={16} />}
							aria-label="刷新质检"
							title="刷新质检"
							onClick={() => void load()}
						/>
					</div>
					{run ? (
						<>
							<div className="article-quality-heading">
								<h3>检查结果</h3>
								<Select
									value={run.id}
									onChange={setSelectedId}
									options={view.runs.map((item) => ({
										value: item.id,
										label: `第 ${item.version} 版 · ${shortDate(item.createdAt)} · ${qualityStatusLabel[item.status]}`,
									}))}
								/>
							</div>
							<Descriptions
								size="small"
								column={2}
								items={[
									{
										key: "state",
										label: "检查状态",
										children: <Tag color={statusColor[run.status]}>{qualityStatusLabel[run.status]}</Tag>,
									},
									{ key: "date", label: "检查时间", children: shortDate(run.createdAt) },
									{ key: "model", label: "质检模型", children: run.model },
									{ key: "review", label: "复核意见", children: run.review?.note ?? "尚未复核" },
								]}
							/>
							{run.error && <Alert type="error" title={run.error} />}
							{run.status === "stale" && <Alert type="warning" title="文章或引用资料已有新版本，此次检查已过期" />}
							{run.validation.map((item) => (
								<Alert key={item} type="warning" title={item} />
							))}
							{run.result && (
								<>
									<p className="article-quality-summary">{run.result.summary}</p>
									{run.result.issues.map((issue) => (
										<section
											className="article-quality-issue"
											key={`${issue.category}-${issue.field}-${issue.message}-${issue.quote}`}
										>
											<div>
												<Tag
													color={
														issue.severity === "blocking"
															? "error"
															: issue.severity === "warning"
																? "warning"
																: "default"
													}
												>
													{issue.severity === "blocking" ? "阻断" : issue.severity === "warning" ? "待核对" : "建议"}
												</Tag>
												<strong>{categoryLabel[issue.category]}</strong>
												<span>{fieldLabel[issue.field]}</span>
											</div>
											<p>{issue.message}</p>
											{issue.quote && <blockquote>{issue.quote}</blockquote>}
											<p className="article-quality-suggestion">{issue.suggestion}</p>
											{issue.evidenceIds.length > 0 && (
												<ul>
													{issue.evidenceIds.map((id) => (
														<li key={id}>{run.sources.find((source) => source.id === id)?.title ?? "引用资料"}</li>
													))}
												</ul>
											)}
										</section>
									))}
									{run.result.issues.length === 0 && <p>此次检查未列出具体问题。</p>}
								</>
							)}
							{currentRun && run.status === "needs_review" && (
								<div className="article-quality-toolbar">
									<Button
										permission="articles.quality.review"
										disabled={!canApproveResult}
										icon={<IconCheck size={16} />}
										onClick={() => setReview({ kind: "quality", decision: "approve" })}
									>
										复核通过
									</Button>
									<Button
										permission="articles.quality.review"
										variant="secondary"
										icon={<IconX size={16} />}
										onClick={() => setReview({ kind: "quality", decision: "reject" })}
									>
										退回复核
									</Button>
								</div>
							)}
							{run.sources.length > 0 && (
								<>
									<h3>本次核对资料</h3>
									<Table
										size="small"
										rowKey="id"
										pagination={false}
										dataSource={run.sources}
										columns={[
											{ title: "资料", dataIndex: "title" },
											{
												title: "来源",
												dataIndex: "kind",
												render: (value: string) =>
													({
														website: "网页证据",
														capture: "采集回答",
														web_search: "联网搜索",
														website_audit: "官网审计",
														knowledge: "客户知识",
													})[value] ?? value,
											},
											{
												title: "版本",
												dataIndex: "revision",
												render: (value?: number) => (value ? `第 ${value} 版` : "冻结证据"),
											},
										]}
									/>
								</>
							)}
						</>
					) : (
						<Empty title="尚未进行文章质检" detail="当前版本没有检查记录。" />
					)}
					{view.reviews.length > 0 && (
						<>
							<h3>内容审核记录</h3>
							<Table
								size="small"
								rowKey="id"
								pagination={false}
								dataSource={view.reviews}
								columns={[
									{ title: "版本", dataIndex: "version", width: 70 },
									{
										title: "结论",
										dataIndex: "decision",
										width: 90,
										render: (value: string) => (value === "approve" ? "通过" : "退回"),
									},
									{ title: "审核意见", dataIndex: "note" },
									{ title: "时间", dataIndex: "createdAt", render: shortDate },
								]}
							/>
						</>
					)}
				</>
			)}
			<Modal
				open={Boolean(review)}
				title={`${review?.kind === "quality" ? "质检复核" : "内容审核"} · ${review?.decision === "approve" ? "通过" : "退回"}`}
				onCancel={() => setReview(null)}
				onOk={() => void submitReview()}
				confirmLoading={busy}
				destroyOnHidden
			>
				<Form form={form} layout="vertical">
					<Form.Item
						name="note"
						label="审核意见"
						rules={[{ required: true, whitespace: true, message: "请填写审核意见" }]}
					>
						<Input.TextArea maxLength={4000} autoSize={{ minRows: 4, maxRows: 10 }} />
					</Form.Item>
				</Form>
			</Modal>
		</section>
	);
}
