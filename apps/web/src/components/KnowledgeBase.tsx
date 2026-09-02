import { IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { Alert, App, Form, Input } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { LibraryQuestion, Paginated, Project } from "../types";
import { date, Empty, Pagination } from "../ui/primitives";

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
		<section className="knowledge-base">
			<div className="overview-head">
				<div>
					<span className="eyebrow">机构知识资产</span>
					<h2>行业问题知识库</h2>
					<p className="muted">新客户官网分析会自动合并同机构、同行业的问题；新增内容只由成员维护。</p>
				</div>
				<Input
					className="knowledge-industry-filter"
					style={{ width: 220 }}
					allowClear
					prefix={<IconSearch size={15} />}
					placeholder="输入行业筛选"
					value={industry}
					onChange={(event) => setIndustry(event.target.value)}
				/>
			</div>
			{error && <Alert type="error" showIcon message={error} />}
			{!canWrite && <Alert type="info" showIcon message="当前为只读角色，可以查看知识库，但不能新增或归档问题。" />}
			<Form layout="inline" className="knowledge-create">
				<Form.Item label="问题">
					<Input
						style={{ width: 320 }}
						placeholder="潜在客户会向 AI 提出的真实问题"
						value={form.question}
						onChange={(event) => setForm({ ...form, question: event.target.value })}
					/>
				</Form.Item>
				<Form.Item label="意图">
					<Input
						style={{ width: 110 }}
						value={form.intent}
						onChange={(event) => setForm({ ...form, intent: event.target.value })}
					/>
				</Form.Item>
				<Form.Item label="主题">
					<Input
						style={{ width: 120 }}
						value={form.topic}
						onChange={(event) => setForm({ ...form, topic: event.target.value })}
					/>
				</Form.Item>
				<Form.Item label="购买者角色">
					<Input
						style={{ width: 130 }}
						value={form.persona}
						onChange={(event) => setForm({ ...form, persona: event.target.value })}
					/>
				</Form.Item>
				<Form.Item label="标签">
					<Input
						style={{ width: 150 }}
						placeholder="逗号分隔"
						value={form.tags}
						onChange={(event) => setForm({ ...form, tags: event.target.value })}
					/>
				</Form.Item>
				<Form.Item>
					<Button
						icon={<IconPlus size={16} />}
						disabled={!canWrite || !industry || form.question.trim().length < 4 || !form.intent}
						onClick={create}
					>
						加入知识库
					</Button>
				</Form.Item>
			</Form>
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
							<Button
								permission="knowledge.manage"
								variant="ghost"
								icon={<IconTrash size={15} />}
								disabled={!canWrite}
								onClick={() =>
									api(`/api/knowledge/questions/${question.id}`, { method: "DELETE" }).then(() =>
										questionsPage.reload(),
									)
								}
							>
								归档
							</Button>
						</article>
					))}
				</div>
			) : (
				<Empty title="该行业还没有问题" detail="添加首个问题后，后续同行业客户建档时会自动复用。" />
			)}
			<Pagination
				{...questionsPage}
				onPage={(page) => void questionsPage.reload(page)}
				onPageSize={questionsPage.setPageSize}
			/>
		</section>
	);
}
