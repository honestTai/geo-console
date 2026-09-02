import { IconSearch } from "@tabler/icons-react";
import { Alert, Collapse, Descriptions, Progress, Table, type TableProps, Tag } from "antd";
import { type ReactNode, useEffect, useState } from "react";
import { Button, useAgentRunPolling } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { AgentRun, EvidenceIndexEntry, Finding, Paginated, Project, ReportPayload } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { BatchPicker, Empty, EvidenceRef, Pagination, SectionTitle } from "../ui/primitives";
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
		render: (confidence: number) => <Progress percent={Math.round(confidence * 100)} size="small" />,
	},
];

function draftValue(value: unknown): ReactNode {
	if (value == null) return "-";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		if (!value.length) return "-";
		return (
			<ul className="draft-list">
				{value.map((item) => (
					<li key={typeof item === "object" && item !== null ? JSON.stringify(item) : `${typeof item}-${String(item)}`}>
						{draftValue(item)}
					</li>
				))}
			</ul>
		);
	}
	return (
		<Collapse
			ghost
			items={[
				{
					key: "object",
					label: "展开对象",
					children: (
						<Descriptions
							size="small"
							column={1}
							items={Object.entries(value).map(([key, entry]) => ({
								key,
								label: key,
								children: draftValue(entry),
							}))}
						/>
					),
				},
			]}
		/>
	);
}

function AgentRunCard({
	run,
	agentRunsPage,
	refresh,
}: {
	run: AgentRun;
	agentRunsPage: ReturnType<typeof usePaginated<AgentRun>>;
	refresh(): Promise<void>;
}) {
	return (
		<article className="agent-draft">
			<div>
				<span className="eyebrow">Pi Agent · {run.model}</span>
				<h3>{run.status === "awaiting_approval" ? "诊断草稿待审批" : `Agent 运行：${run.status}`}</h3>
				<p>
					{run.error_message ??
						(["queued", "running"].includes(run.status)
							? "Agent 正在后台读取项目证据；离开页面不会中断任务。"
							: "草稿中的每个结论已通过证据 ID 白名单校验；批准前不会写入正式诊断。")}
				</p>
				{run.draft && (
					<Collapse
						className="agent-draft-detail"
						items={[
							{
								key: "draft",
								label: "查看草稿详情",
								children: (
									<Descriptions
										size="small"
										column={1}
										items={Object.entries(run.draft).map(([key, value]) => ({
											key,
											label: key,
											children: draftValue(value),
										}))}
									/>
								),
							},
						]}
					/>
				)}
			</div>
			{run.status === "awaiting_approval" && (
				<div className="actions">
					<Button
						permission="agent.approve"
						variant="secondary"
						onClick={() => post(`/api/agent-runs/${run.id}/reject`).then(() => agentRunsPage.reload())}
					>
						拒绝
					</Button>
					<Button
						onClick={() =>
							post(`/api/agent-runs/${run.id}/approve`).then(async () => {
								await agentRunsPage.reload();
								await refresh();
							})
						}
					>
						批准并入库
					</Button>
				</div>
			)}
		</article>
	);
}

export function Diagnosis({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [busy, setBusy] = useState<"rules" | "model" | null>(null);
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
	const [evidenceIndex, setEvidenceIndex] = useState<EvidenceIndexEntry[]>([]);
	useEffect(() => {
		if (!selected) return;
		let current = true;
		api<ReportPayload>(`/api/batches/${selected}/report`)
			.then((payload) => {
				if (current) setEvidenceIndex(payload.analysis?.evidenceIndex ?? []);
			})
			.catch(() => {
				if (current) setEvidenceIndex([]);
			});
		return () => {
			current = false;
		};
	}, [selected]);
	const [findingPage, setFindingPage] = useState(1);
	const findings = project.findings.filter((item) => item.batch_id === selected);
	const visibleFindings = findings.slice((findingPage - 1) * 10, findingPage * 10);
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
	if (!project.batches.length)
		return (
			<Page breadcrumb={project.name} eyebrow="差距诊断" title="证据定位的可整改差距">
				<Empty title="尚不能诊断" detail="诊断必须基于成功采集的真实回答。请先建立基线。" />
			</Page>
		);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="差距诊断"
			title="证据定位的可整改差距"
			description="确定性规则输出可复核指标；Pi Agent 只能读取项目证据，并通过 HRouter GPT 生成待人工审批草稿。"
			extra={
				<div className="actions">
					<BatchPicker project={project} selected={selected} setSelected={setSelected} />
					<Button permission="agent.run" variant="secondary" busy={busy === "model"} onClick={() => run(true)}>
						Pi Agent 诊断草稿
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
			{error && <Alert type="error" showIcon message={error} />}
			{agentRuns.length > 0 && (
				<>
					<SectionTitle title="Agent 诊断草稿" count={agentRunsPage.total} />
					<div className="agent-draft-list">
						{agentRuns.map((run) => (
							<AgentRunCard key={run.id} run={run} agentRunsPage={agentRunsPage} refresh={refresh} />
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
												onOpen={(captureId) => navigation.openEvidence(captureId, selected)}
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
				pageSize={10}
				total={findings.length}
				totalPages={Math.max(1, Math.ceil(findings.length / 10))}
				onPage={setFindingPage}
			/>
		</Page>
	);
}
