import { IconSearch } from "@tabler/icons-react";
import { Alert, Descriptions, Progress, Table, type TableProps, Tag } from "antd";
import { useState } from "react";
import { Button, useAgentRunPolling } from "../access";
import { api, post } from "../api";
import { useEvidenceIndex } from "../hooks/useEvidenceIndex";
import { usePaginated } from "../hooks/usePagination";
import { type AgentRun, DEFAULT_PAGE_SIZE, type Finding, type Paginated, type Project } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { BatchPicker, Empty, EvidenceRef, Pagination, SectionTitle } from "../ui/primitives";
import { AgentDraftCard } from "./AgentDraft";
import "./Diagnosis.css";
import { Page } from "./Page";

const findingColumns: TableProps<Finding>["columns"] = [
	{
		title: "类别",
		dataIndex: "category",
		width: 140,
		render: (category: string) => <Tag>{category}</Tag>,
	},
	{ title: "差距", dataIndex: "title" },
	{
		title: "置信度",
		dataIndex: "confidence",
		width: 160,
		// 置信度是证据充分程度，不是成败：用中性色，100% 也显示数字而不是打勾
		render: (confidence: number) => (
			<Progress
				className="finding-confidence"
				percent={Math.round(confidence * 100)}
				size="small"
				strokeColor="#667085"
				format={(percent) => `${percent ?? 0}%`}
			/>
		),
	},
];

export function Diagnosis({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [busy, setBusy] = useState<"rules" | "model" | string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const agentRunsPage = usePaginated<AgentRun>(
		(page, pageSize) => {
			const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), purposes: "diagnosis" });
			if (selected) params.set("batchId", selected);
			return api<Paginated<AgentRun>>(`/api/projects/${project.id}/agent-runs?${params}`);
		},
		[project.id, selected],
	);
	const agentRuns = agentRunsPage.items;
	const navigation = useWorkspaceNavigation();
	const evidenceIndex = useEvidenceIndex(selected, project.id);
	const [findingPage, setFindingPage] = useState(1);
	const findings = project.findings.filter((item) => item.batch_id === selected);
	const visibleFindings = findings.slice((findingPage - 1) * DEFAULT_PAGE_SIZE, findingPage * DEFAULT_PAGE_SIZE);
	useAgentRunPolling(agentRuns, agentRunsPage.reload);
	async function run(enhanceWithModel = false) {
		if (!selected) return;
		setBusy(enhanceWithModel ? "model" : "rules");
		setError(null);
		try {
			await post(`/api/batches/${selected}/diagnose${enhanceWithModel ? "/model" : ""}`);
			if (enhanceWithModel) await agentRunsPage.reload();
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "诊断失败");
		} finally {
			setBusy(null);
		}
	}
	async function decide(runId: string, decision: "approve" | "reject") {
		setBusy(runId);
		setError(null);
		try {
			await post(`/api/agent-runs/${runId}/${decision}`);
			await agentRunsPage.reload();
			if (decision === "approve") await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	if (!project.batches.length)
		return (
			<Page breadcrumb={project.name} eyebrow="差距诊断" title="可整改差距">
				<Empty title="尚不能诊断" detail="诊断必须基于成功采集的真实回答。请先建立基线。" />
			</Page>
		);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="差距诊断"
			title="可整改差距"
			description="规则计算差距指标；Agent 诊断草稿需人工审批。"
			extra={
				<div className="actions">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button permission="agent.run" variant="secondary" busy={busy === "model"} onClick={() => run(true)}>
						HRouter Agent 诊断草稿
					</Button>
					<Button
						permission="diagnosis.run"
						busy={busy === "rules"}
						icon={<IconSearch size={17} />}
						onClick={() => run()}
					>
						生成证据诊断
					</Button>
				</div>
			}
		>
			{error && <Alert type="error" showIcon title={error} />}
			{agentRuns.length > 0 && (
				<>
					<SectionTitle title="Agent 诊断草稿" count={agentRunsPage.total} />
					<div className="agent-draft-list">
						{agentRuns.map((run) => (
							<AgentDraftCard
								key={run.id}
								run={run}
								evidenceIndex={evidenceIndex}
								onOpenEvidence={(id, kind) => navigation.openEvidence(id, selected, kind)}
								busy={busy === run.id}
								onReject={() => void decide(run.id, "reject")}
								onApprove={() => void decide(run.id, "approve")}
							/>
						))}
					</div>
					<Pagination {...agentRunsPage} onPage={(page) => void agentRunsPage.reload(page)} />
				</>
			)}
			<SectionTitle
				title="规则诊断结果"
				count={findings.length || undefined}
				description="由确定性证据规则计算，可直接转为整改任务。"
			/>
			{findings.length === 0 ? (
				<Empty
					title="这个批次还没有诊断"
					detail="采集完成后可直接运行证据规则；没有模型密钥也能生成真实诊断和整改任务。"
				/>
			) : (
				<Table<Finding>
					className="gap-table"
					rowKey="id"
					columns={findingColumns}
					dataSource={visibleFindings}
					pagination={false}
					expandable={{
						expandedRowRender: (finding) => (
							<Descriptions
								size="small"
								column={1}
								items={[
									{ key: "detail", label: "详情", children: finding.detail },
									{ key: "recommendation", label: "整改建议", children: finding.recommendation },
									{
										key: "evidence",
										label: "关联证据",
										children: finding.evidence_ids.length ? (
											<EvidenceRef
												ids={finding.evidence_ids}
												index={evidenceIndex}
												onOpen={(id, kind) => navigation.openEvidence(id, selected, kind)}
											/>
										) : (
											"-"
										),
									},
								]}
							/>
						),
					}}
				/>
			)}
			<Pagination
				page={findingPage}
				pageSize={DEFAULT_PAGE_SIZE}
				total={findings.length}
				totalPages={Math.max(1, Math.ceil(findings.length / DEFAULT_PAGE_SIZE))}
				onPage={setFindingPage}
			/>
		</Page>
	);
}
