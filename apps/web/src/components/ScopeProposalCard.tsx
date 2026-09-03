import { IconCheck, IconPlus, IconTrash } from "@tabler/icons-react";
import { Input, Switch, Table, type TableProps, Tag, Tooltip } from "antd";
import { useMemo, useState } from "react";
import { Button, usePermission } from "../access";
import {
	type EvidenceIndexEntry,
	proposalSourceLabels,
	type ScopeProposal,
	type ScopeProposalCompetitor,
	type ScopeProposalQuestion,
} from "../types";
import { FormattedAnswer } from "../ui/markdown";
import { type EvidenceOpener, EvidenceRef } from "../ui/primitives";
import { splitEditableValues } from "./EditableList";
import "./ScopeProposalCard.css";

export type ScopeProposalAnswer = {
	questions: Array<{
		id: string | null;
		libraryQuestionId: string | null;
		question: string;
		intent: string;
		topic: string | null;
		persona: string | null;
		tags: string[];
	}>;
	competitors?: Array<{ id: string | null; name: string; domain: string; aliases: string[] }>;
	syncLibrary: boolean;
	answer?: string;
};

type QuestionRow = ScopeProposalQuestion;
type CompetitorRow = ScopeProposalCompetitor;

/**
 * 工作台候选问题确认卡：Agent 用 propose_questions 提交的候选在这里渲染成可勾选、可编辑的表格
 * （问题、意图、主题、角色，附来源与研究依据），成员改完点确认后由服务端直接写入监测范围。
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 表格编辑、竞品确认、知识库同步与提交校验集中在一张卡里，便于成员一屏完成确认。
export function ScopeProposalCard({
	proposal,
	disabled,
	answered,
	answeredText,
	onOpenEvidence,
	onConfirm,
	onReject,
}: {
	proposal: ScopeProposal;
	disabled: boolean;
	answered: boolean;
	answeredText: string | null;
	onOpenEvidence?: EvidenceOpener;
	onConfirm(answer: ScopeProposalAnswer): Promise<void>;
	onReject(reason: string): Promise<void>;
}) {
	const canWriteKnowledge = usePermission("knowledge.manage");
	const [questions, setQuestions] = useState<QuestionRow[]>(proposal.questions);
	const [competitors, setCompetitors] = useState<CompetitorRow[]>(proposal.competitors);
	const [syncLibrary, setSyncLibrary] = useState(Boolean(proposal.industry) && canWriteKnowledge);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
	const evidenceIndex = useMemo(() => proposal.evidence ?? [], [proposal.evidence]);
	const selectedQuestions = questions.filter((row) => row.selected);
	const invalidRows = selectedQuestions.filter((row) => row.question.trim().length < 4 || !row.intent.trim());
	const newQuestionCount = selectedQuestions.filter((row) => !row.libraryQuestionId).length;

	const patchQuestion = (key: string, patch: Partial<QuestionRow>) =>
		setQuestions((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
	const patchCompetitor = (key: string, patch: Partial<CompetitorRow>) =>
		setCompetitors((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

	const questionColumns: TableProps<QuestionRow>["columns"] = [
		{
			title: "问题",
			dataIndex: "question",
			render: (_: unknown, row) => (
				<Input.TextArea
					autoSize={{ minRows: 1, maxRows: 3 }}
					value={row.question}
					disabled={answered || disabled}
					status={row.selected && row.question.trim().length < 4 ? "error" : undefined}
					onChange={(event) => patchQuestion(row.key, { question: event.target.value })}
				/>
			),
		},
		{
			title: "意图",
			dataIndex: "intent",
			width: 120,
			render: (_: unknown, row) => (
				<Input
					value={row.intent}
					disabled={answered || disabled}
					status={row.selected && !row.intent.trim() ? "error" : undefined}
					onChange={(event) => patchQuestion(row.key, { intent: event.target.value })}
				/>
			),
		},
		{
			title: "主题",
			dataIndex: "topic",
			width: 120,
			render: (_: unknown, row) => (
				<Input
					value={row.topic ?? ""}
					disabled={answered || disabled}
					onChange={(event) => patchQuestion(row.key, { topic: event.target.value || null })}
				/>
			),
		},
		{
			title: "购买者角色",
			dataIndex: "persona",
			width: 130,
			render: (_: unknown, row) => (
				<Input
					value={row.persona ?? ""}
					disabled={answered || disabled}
					onChange={(event) => patchQuestion(row.key, { persona: event.target.value || null })}
				/>
			),
		},
		{
			title: "来源与依据",
			key: "source",
			width: 190,
			render: (_: unknown, row) => (
				<span className="sp-source">
					<Tag>{proposalSourceLabels[row.source] ?? row.source}</Tag>
					{row.evidenceIds.length > 0 && (
						<EvidenceRef ids={row.evidenceIds} index={evidenceIndex} onOpen={onOpenEvidence} compact max={2} />
					)}
				</span>
			),
		},
		{
			key: "remove",
			width: 44,
			render: (_: unknown, row) =>
				answered || disabled ? null : (
					<Button
						variant="ghost"
						size="small"
						aria-label="删除该问题"
						icon={<IconTrash size={15} />}
						onClick={() => setQuestions((rows) => rows.filter((item) => item.key !== row.key))}
					/>
				),
		},
	];
	const competitorColumns: TableProps<CompetitorRow>["columns"] = [
		{
			title: "竞品名称",
			dataIndex: "name",
			render: (_: unknown, row) => (
				<Input
					value={row.name}
					disabled={answered || disabled}
					onChange={(event) => patchCompetitor(row.key, { name: event.target.value })}
				/>
			),
		},
		{
			title: "域名",
			dataIndex: "domain",
			width: 200,
			render: (_: unknown, row) => (
				<Input
					value={row.domain}
					disabled={answered || disabled}
					onChange={(event) => patchCompetitor(row.key, { domain: event.target.value })}
				/>
			),
		},
		{
			title: "别名",
			dataIndex: "aliases",
			width: 180,
			render: (_: unknown, row) => (
				<Input
					value={row.aliases.join("，")}
					placeholder="逗号分隔"
					disabled={answered || disabled}
					onChange={(event) => patchCompetitor(row.key, { aliases: splitEditableValues(event.target.value) })}
				/>
			),
		},
	];

	async function confirm() {
		setBusy("confirm");
		try {
			await onConfirm({
				questions: selectedQuestions.map((row) => ({
					id: row.id,
					libraryQuestionId: row.libraryQuestionId,
					question: row.question.trim(),
					intent: row.intent.trim(),
					topic: row.topic?.trim() || null,
					persona: row.persona?.trim() || null,
					tags: row.tags,
				})),
				...(proposal.competitors.length
					? {
							competitors: competitors
								.filter((row) => row.selected && row.name.trim() && row.domain.trim())
								.map((row) => ({ id: row.id, name: row.name.trim(), domain: row.domain.trim(), aliases: row.aliases })),
						}
					: {}),
				syncLibrary: syncLibrary && canWriteKnowledge && Boolean(proposal.industry),
				answer: note.trim() || undefined,
			});
		} finally {
			setBusy(null);
		}
	}
	async function reject() {
		setBusy("reject");
		try {
			await onReject(note.trim());
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="sp-card">
			<div className="sp-intro">
				<FormattedAnswer value={proposal.intro} />
			</div>
			<Table<QuestionRow>
				className="sp-table"
				size="small"
				rowKey="key"
				pagination={false}
				columns={questionColumns}
				dataSource={questions}
				scroll={{ x: 760 }}
				rowSelection={{
					selectedRowKeys: questions.filter((row) => row.selected).map((row) => row.key),
					onChange: (keys) => setQuestions((rows) => rows.map((row) => ({ ...row, selected: keys.includes(row.key) }))),
					getCheckboxProps: () => ({ disabled: answered || disabled }),
				}}
				locale={{ emptyText: "没有候选问题，点“添加问题”手工补充" }}
			/>
			{!answered && !disabled && (
				<Button
					variant="secondary"
					size="small"
					icon={<IconPlus size={14} />}
					onClick={() =>
						setQuestions((rows) => [
							...rows,
							{
								key: `m${rows.length + 1}-${Date.now()}`,
								id: null,
								libraryQuestionId: null,
								question: "",
								intent: "购买决策",
								topic: null,
								persona: null,
								tags: [],
								source: "research",
								evidenceIds: [],
								selected: true,
							},
						])
					}
				>
					添加问题
				</Button>
			)}
			{proposal.competitors.length > 0 && (
				<>
					<p className="sp-section">竞品候选 · 勾选要纳入监测范围的竞品</p>
					<Table<CompetitorRow>
						className="sp-table"
						size="small"
						rowKey="key"
						pagination={false}
						columns={competitorColumns}
						dataSource={competitors}
						scroll={{ x: 560 }}
						rowSelection={{
							selectedRowKeys: competitors.filter((row) => row.selected).map((row) => row.key),
							onChange: (keys) =>
								setCompetitors((rows) => rows.map((row) => ({ ...row, selected: keys.includes(row.key) }))),
							getCheckboxProps: () => ({ disabled: answered || disabled }),
						}}
					/>
				</>
			)}
			{answered ? (
				<p className="sp-answered">
					<IconCheck size={14} />
					{answeredText ?? "已回答"}
				</p>
			) : (
				<>
					{canWriteKnowledge && (
						<Tooltip
							title={
								proposal.industry
									? "只写入没有知识库引用的新问题；同行业客户建档时会自动复用"
									: "客户未填写行业，无法归入行业知识库"
							}
						>
							<span className="sp-switch">
								<Switch
									size="small"
									checked={syncLibrary && Boolean(proposal.industry)}
									disabled={disabled || !proposal.industry}
									onChange={setSyncLibrary}
								/>
								{proposal.industry
									? `确认后把 ${newQuestionCount} 个新问题同步写入「${proposal.industry}」行业知识库`
									: "客户未填写行业，无法写入知识库"}
							</span>
						</Tooltip>
					)}
					<Input.TextArea
						autoSize={{ minRows: 1, maxRows: 4 }}
						placeholder="补充说明（可选）；不采用时请写明原因，Agent 会据此调整"
						value={note}
						disabled={disabled}
						onChange={(event) => setNote(event.target.value)}
					/>
					<div className="sp-actions">
						<Button
							variant="secondary"
							busy={busy === "reject"}
							disabled={disabled || busy !== null || !note.trim()}
							onClick={() => void reject()}
						>
							不采用，让 Agent 调整
						</Button>
						<Tooltip
							title={
								invalidRows.length
									? "勾选的问题需要至少 4 个字并填写意图"
									: !selectedQuestions.length
										? "至少勾选一个问题"
										: undefined
							}
						>
							<span>
								<Button
									icon={<IconCheck size={16} />}
									busy={busy === "confirm"}
									disabled={disabled || busy !== null || !selectedQuestions.length || invalidRows.length > 0}
									onClick={() => void confirm()}
								>
									确认并写入监测范围（{selectedQuestions.length} 题）
								</Button>
							</span>
						</Tooltip>
					</div>
				</>
			)}
		</div>
	);
}
