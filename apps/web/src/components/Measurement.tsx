import { Alert, App, Descriptions, Drawer, Input, Space, Table, Tag } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { type Batch, providerLabel } from "../types";
import { percentage, SectionTitle } from "../ui/primitives";

type Observation = {
	id: string;
	capture_id: string;
	status: string;
	pass_kind: string;
	observation: unknown;
	validation: string[];
	selected: boolean;
};
const labels: Record<string, string> = {
	queued: "等待语义解析",
	running: "语义解析中",
	ready: "达到正式证据门槛",
	partial: "有限结果",
	failed: "解析失败或证据不足",
	not_configured: "未配置 V2 测量",
	capture_contract_changed: "旧采集解析协议（只读）",
};

export function Measurement({
	batch,
	review = false,
	onRefresh,
}: {
	batch: Batch;
	review?: boolean;
	onRefresh?(): void;
}) {
	const { message } = App.useApp();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [page, setPage] = useState(1);
	const [data, setData] = useState<{
		observations: Observation[];
		total: number;
		runId: string | null;
		status?: string;
		payload?: Batch["metrics"];
	}>({ observations: [], total: 0, runId: null });
	const [editing, setEditing] = useState<Observation | null>(null);
	const [text, setText] = useState("");
	const [reason, setReason] = useState("");
	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const result = await api<typeof data>(`/api/batches/${batch.id}/measurement?page=${page}&pageSize=20`, {
					signal,
				});
				if (!signal?.aborted) {
					setData(result);
					setError(null);
				}
			} catch (e) {
				if (!signal?.aborted) setError(e instanceof Error ? e.message : "语义观察加载失败");
			}
		},
		[batch.id, page],
	);
	useEffect(() => {
		if (!review) return;
		const controller = new AbortController();
		void load(controller.signal);
		const timer = window.setInterval(() => void load(controller.signal), 5_000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, [load, review]);
	const status = (review ? data.status : null) ?? batch.measurement?.status ?? "not_configured";
	const active = ["queued", "running"].includes(status);
	const finishedCapture = ["complete", "partial"].includes(batch.status);
	const compatible = batch.measurement?.captureContractCurrent !== false;
	const showScores =
		compatible && !active && Boolean(review && data.runId ? data.payload : batch.measurement?.snapshotId);
	const overall = showScores ? (review && data.runId ? data.payload?.overall : batch.metrics.overall) : null;
	const platforms = Object.entries((review ? data.payload : null)?.perPlatform ?? batch.metrics.perPlatform).map(
		([platform, metrics]) => ({
			platform,
			...metrics,
			...(showScores
				? {}
				: {
						brandMentionRate: null,
						recommendationRate: null,
						explicitRecommendationRate: null,
						confidenceIntervals: undefined,
						parseCoverage: null,
						promptCoverage: 0,
						eligiblePromptCount: 0,
					}),
		}),
	);
	async function reparse() {
		setBusy(true);
		try {
			await post(`/api/batches/${batch.id}/measurement`);
			message.success("已创建独立 V2 解析运行，原始证据不变");
			onRefresh?.();
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "重解析失败");
		} finally {
			setBusy(false);
		}
	}
	async function submitReview() {
		if (!editing) return;
		setBusy(true);
		try {
			await post(`/api/batches/${batch.id}/measurement/review`, {
				runId: data.runId,
				captureId: editing.capture_id,
				observation: JSON.parse(text),
				reason,
			});
			setEditing(null);
			message.success("已审计保存人工观察，正在生成新的指标快照");
			onRefresh?.();
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "审核失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section aria-label="V2 语义测量">
			<SectionTitle
				title="API 可见度 V2"
				description="问题内重复采样 → 问题等权 → 达标平台等权；失败和不可见来源不是零分。"
				extra={
					<Button
						permission="agent.run"
						size="small"
						busy={busy}
						disabled={!compatible || active || !finishedCapture}
						onClick={() => void reparse()}
					>
						重新解析
					</Button>
				}
			/>
			<Space wrap>
				<Tag>{labels[status] ?? status}</Tag>
				<span>消费端 App：尚未采集（不计为 0）</span>
			</Space>
			{!compatible && (
				<Alert
					type="warning"
					showIcon
					title="采集正文与引用协议已更新。此批次仅用于原始记录审计；请新建批次，不可通过重解析旧回答继续出报告。"
				/>
			)}
			{error && <Alert type="error" title={error} showIcon />}
			{status !== "ready" && (
				<Alert
					type="info"
					showIcon
					title={
						active
							? "采集状态与语义分析状态独立；当前暂不展示推荐分数。"
							: "有限或不可用结果不形成统计显著漂移结论。快审仅为时点快照。"
					}
				/>
			)}
			<Descriptions
				size="small"
				column={{ xs: 1, sm: 2, lg: 3 }}
				items={[
					{ key: "mention", label: "整体品牌提及率", children: percentage(overall?.brandMentionRate) },
					{
						key: "interval",
						label: "95% 问题聚类区间",
						children: overall?.confidenceIntervals?.brandMentionRate?.map((v) => percentage(v)).join(" – ") ?? "不可用",
					},
					{
						key: "recommendation",
						label: "推荐 / 明确 / 首位",
						children: `${percentage(overall?.recommendationRate)} / ${percentage(overall?.explicitRecommendationRate)} / ${percentage(overall?.firstRecommendationRate)}`,
					},
				]}
			/>
			<Table
				size="small"
				rowKey="platform"
				pagination={false}
				scroll={{ x: 760 }}
				dataSource={platforms}
				columns={[
					{ title: "平台", dataIndex: "platform", render: (platform: string) => providerLabel(platform) },
					{ title: "采集覆盖", render: (_, row) => percentage(row.captureCoverage) },
					{ title: "解析覆盖", render: (_, row) => percentage(row.parseCoverage) },
					{
						title: "问题覆盖",
						render: (_, row) =>
							`${row.eligiblePromptCount ?? 0}/${row.plannedPromptCount ?? batch.config.prompts.length}（${percentage(row.promptCoverage)}）`,
					},
					{
						title: "提及率 / 95% 区间",
						render: (_, row) =>
							`${percentage(row.brandMentionRate)} / ${row.confidenceIntervals?.brandMentionRate?.map((v) => percentage(v)).join("–") ?? "不可用"}`,
					},
					{
						title: "推荐 / 明确推荐",
						render: (_, row) => `${percentage(row.recommendationRate)} / ${percentage(row.explicitRecommendationRate)}`,
					},
				]}
			/>
			{review && (
				<Table
					size="small"
					rowKey="id"
					scroll={{ x: 700 }}
					dataSource={data.observations}
					pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showSizeChanger: false }}
					columns={[
						{
							title: "回答",
							render: (_, row) =>
								batch.captures.find((c) => c.captureId === row.capture_id)?.prompt ?? row.capture_id.slice(0, 8),
						},
						{ title: "解析阶段", dataIndex: "pass_kind" },
						{ title: "结果", render: (_, row) => (row.selected ? "已采用" : `${row.status} · 未采用`) },
						{ title: "校验", render: (_, row) => row.validation?.join("；") || "结构与证据校验通过" },
						{
							title: "操作",
							render: (_, row) => (
								<Button
									permission="agent.approve"
									size="small"
									disabled={active}
									onClick={() => {
										setEditing(row);
										setText(JSON.stringify(row.observation, null, 2));
										setReason("");
									}}
								>
									审核
								</Button>
							),
						},
					]}
				/>
			)}
			<Drawer
				title="审核原子语义（保存新观察，不改原文）"
				open={Boolean(editing)}
				onClose={() => setEditing(null)}
				size="large"
			>
				<Descriptions
					column={1}
					items={[
						{
							key: "answer",
							label: "原始回答",
							children: (
								<pre style={{ whiteSpace: "pre-wrap" }}>
									{batch.captures.find((c) => c.captureId === editing?.capture_id)?.answerText}
								</pre>
							),
						},
					]}
				/>
				<Input.TextArea
					value={text}
					onChange={(e) => setText(e.target.value)}
					autoSize={{ minRows: 12, maxRows: 24 }}
					aria-label="语义 JSON"
				/>
				<Input.TextArea
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					placeholder="审核依据（至少 3 字）"
					aria-label="审核依据"
				/>
				<Button
					permission="agent.approve"
					busy={busy}
					disabled={reason.trim().length < 3}
					onClick={() => void submitReview()}
				>
					通过证据校验后保存
				</Button>
			</Drawer>
		</section>
	);
}
