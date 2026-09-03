import { IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { Alert, App, Form, Input, Popconfirm } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { LibraryQuestion, Paginated, Project } from "../types";
import { date, Empty, FilterBar, Pagination, SectionTitle } from "../ui/primitives";
import { downloadJson, TransferButtons, transferFileName } from "../ui/transfer";
import "./KnowledgeBase.css";
import { Page } from "./Page";

export function KnowledgeBase({
	project,
	initialIndustry,
	canWrite,
}: {
	project?: Project;
	initialIndustry?: string | null;
	canWrite: boolean;
}) {
	const { message } = App.useApp();
	const [industry, setIndustry] = useState(project?.industry ?? initialIndustry ?? "");
	const [error, setError] = useState<string | null>(null);
	const questionsPage = usePaginated<LibraryQuestion>(
		(page, pageSize) => {
			const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
			if (industry) params.set("industry", industry);
			return api<Paginated<LibraryQuestion>>(`/api/knowledge/questions?${params}`);
		},
		[industry],
		{ onError: (reason) => setError(reason instanceof Error ? reason.message : "问题库加载失败") },
	);
	const questions = questionsPage.items;
	const [form, setForm] = useState({ question: "", intent: "购买决策", topic: "", persona: "", tags: "" });
	async function create() {
		setError(null);
		try {
			await post("/api/knowledge/questions", {
				industry,
				question: form.question,
				intent: form.intent,
				topic: form.topic || null,
				persona: form.persona || null,
				tags: form.tags
					.split(/[，,]/)
					.map((value) => value.trim())
					.filter(Boolean),
			});
			setForm({ question: "", intent: "购买决策", topic: "", persona: "", tags: "" });
			await questionsPage.reload();
			message.success("已加入知识库");
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "问题添加失败");
		}
	}
	return (
		<Page
			className="knowledge-base"
			breadcrumb={project?.name}
			eyebrow="问题知识库"
			title="行业问题知识库"
			description="同机构、同行业的问题在新客户建档时自动复用。"
			extra={
				<div className="actions">
					<TransferButtons
						exportLabel={industry ? `导出「${industry}」` : "导出知识库"}
						importLabel="导入知识库"
						expectedKind="geo-knowledge"
						kindLabel="知识库"
						importPermission="knowledge.manage"
						onExport={async () => {
							const params = industry ? `?industry=${encodeURIComponent(industry)}` : "";
							downloadJson(transferFileName(`geo-知识库${industry ? `-${industry}` : ""}`), await api(`/api/knowledge/export${params}`));
						}}
						onImport={async (bundle) => {
							const result = await post<{ total: number; imported: number; skipped: number }>("/api/knowledge/import", bundle);
							await questionsPage.reload();
							return `已导入 ${result.imported} 个问题${result.skipped ? `，${result.skipped} 个已存在跳过` : ""}`;
						}}
					/>
				</div>
			}
		>
			{error && <Alert type="error" showIcon title={error} />}
			{!canWrite && <Alert type="info" showIcon title="当前为只读角色，可以查看知识库，但不能新增或归档问题。" />}
			<FilterBar
				extra={<span className="knowledge-count">{questionsPage.total ? `${questionsPage.total} 个问题` : ""}</span>}
			>
				<Input
					allowClear
					prefix={<IconSearch size={15} />}
					placeholder="按行业筛选，如：数控设备"
					value={industry}
					onChange={(event) => setIndustry(event.target.value)}
				/>
			</FilterBar>
			{canWrite && (
				<Form layout="vertical" className="knowledge-form">
					<SectionTitle
						title="加入新问题"
						description={
							industry ? `将加入「${industry}」行业，同行业客户建档时自动复用。` : "先在上方填写行业，再添加问题。"
						}
					/>
					<div className="knowledge-form-grid">
						<Form.Item label="问题" className="knowledge-form-question">
							<Input
								placeholder="潜在客户会向 AI 提出的真实问题"
								value={form.question}
								onChange={(event) => setForm({ ...form, question: event.target.value })}
							/>
						</Form.Item>
						<Form.Item label="意图">
							<Input value={form.intent} onChange={(event) => setForm({ ...form, intent: event.target.value })} />
						</Form.Item>
						<Form.Item label="主题">
							<Input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} />
						</Form.Item>
						<Form.Item label="购买者角色">
							<Input value={form.persona} onChange={(event) => setForm({ ...form, persona: event.target.value })} />
						</Form.Item>
						<Form.Item label="标签">
							<Input
								placeholder="逗号分隔"
								value={form.tags}
								onChange={(event) => setForm({ ...form, tags: event.target.value })}
							/>
						</Form.Item>
						<Form.Item label=" " className="knowledge-form-submit">
							<Button
								icon={<IconPlus size={16} />}
								disabled={!industry || form.question.trim().length < 4 || !form.intent}
								onClick={create}
							>
								加入知识库
							</Button>
						</Form.Item>
					</div>
				</Form>
			)}
			<SectionTitle title="问题列表" count={questionsPage.total || undefined} />
			{questions.length ? (
				<div className="knowledge-list">
					{questions.map((question) => (
						<article key={question.id}>
							<div>
								<span>{question.industry}</span>
								<h3>{question.question}</h3>
								<p>
									{question.intent}
									{question.topic ? ` · ${question.topic}` : ""}
									{question.persona ? ` · ${question.persona}` : ""}
								</p>
								<small>
									{question.created_by_email ?? "系统"} · {date(question.created_at)}
								</small>
							</div>
							<Popconfirm
								title="归档这个问题？"
								description="归档后不再出现在知识库和新客户建档里，已引用它的项目问题不受影响。"
								okText="归档"
								cancelText="取消"
								onConfirm={() =>
									api(`/api/knowledge/questions/${question.id}`, { method: "DELETE" }).then(() =>
										questionsPage.reload(),
									)
								}
							>
								<span>
									<Button permission="knowledge.manage" variant="ghost" icon={<IconTrash size={15} />} disabled={!canWrite}>
										归档
									</Button>
								</span>
							</Popconfirm>
						</article>
					))}
				</div>
			) : (
				<Empty
					title={industry ? `「${industry}」还没有问题` : "知识库还没有问题"}
					detail="添加或导入问题后，同行业客户建档时会自动复用；归档的问题不再显示。"
				/>
			)}
			<Pagination
				{...questionsPage}
				onPage={(page) => void questionsPage.reload(page)}
				onPageSize={questionsPage.setPageSize}
			/>
		</Page>
	);
}
