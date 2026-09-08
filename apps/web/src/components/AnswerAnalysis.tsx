import { ANSWER_ANALYSIS_MAX_LENGTH, type AnalysisEvidenceSpan, type AnswerAnalysisView } from "@geo/evidence";
import { Alert, Drawer, Button as PlainButton, Popconfirm, Skeleton, Space, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { Button } from "../access";
import { useAnswerAnalysis } from "../hooks/useAnswerAnalysis";
import type { Capture } from "../types";
import { AnswerAnalysisContent, HighlightedAnswer } from "../ui/answer-analysis";
import { date, downloadText } from "../ui/primitives";
import "./AnswerAnalysis.css";

const statuses: Record<string, string> = {
	not_generated: "尚未生成",
	queued: "等待完整分析",
	running: "正在解读全文",
	ready: "解读已生成 · 未人工复核",
	needs_review: "存在歧义或覆盖不足",
	failed: "分析未完成",
};

function AnalysisRunFeedback({ data }: { data: AnswerAnalysisView }) {
	if (data.status === "not_generated")
		return (
			<div className="aa-empty">
				<strong>把“被提及”展开为“被怎样评价”</strong>
				<p>生成后可查看：全文概览、核心观点、品牌评价维度、推荐理由和条件、品牌比较、全文分段与歧义。</p>
				<p className="muted">生成分析会调用模型，可能产生费用。分析结果不影响监测排名与指标。</p>
			</div>
		);
	if (["queued", "running"].includes(data.status))
		return <Alert type="info" showIcon title="正在分析回答，可稍后回来查看。" description={data.error} />;
	if (data.status === "failed")
		return <Alert type="error" showIcon title={data.error ?? "完整分析失败，请核对模型配置后重新生成。"} />;
	if (data.status === "needs_review")
		return (
			<Alert
				type="warning"
				showIcon
				title="以下解读尚不完整或存在语义歧义，请核对原文。"
				description={data.issues.join("；") || "部分判断仍需人工确认。"}
			/>
		);
	return null;
}

function AnalysisMetadata({ data }: { data: AnswerAnalysisView }) {
	if (!data.contract) return null;
	return (
		<footer className="aa-footer">
			<span>
				{data.contract.modelId} · {data.contract.version} · {date(data.createdAt)}
			</span>
			<span>
				模型修订：{data.contract.modelRevision ?? "未提供不可变版本"} · Tokens：{data.usage?.totalTokens ?? "未知"} ·
				费用：{data.costMicros === null ? "未知" : `${data.costMicros / 1_000_000} 元`}
			</span>
		</footer>
	);
}

export function AnswerAnalysis({ batchId, capture }: { batchId: string; capture: Capture }) {
	const { data, error, loading, busy, generate, selectRun, reload } = useAnswerAnalysis(batchId, capture.captureId);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [selectedSpan, setSelectedSpan] = useState<AnalysisEvidenceSpan | null>(null);
	const mark = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!sourceOpen || !selectedSpan) return;
		const timer = window.setTimeout(() => mark.current?.scrollIntoView({ block: "center", behavior: "auto" }), 100);
		return () => clearTimeout(timer);
	}, [sourceOpen, selectedSpan]);
	const active = data && ["queued", "running"].includes(data.status);
	const history = Boolean(data?.id && data.latestRunId !== data.id);
	const tooLong = (capture.answerText?.length ?? 0) > ANSWER_ANALYSIS_MAX_LENGTH;
	const action = (
		<Button
			permission="agent.run"
			size="small"
			busy={busy}
			disabled={loading || Boolean(active) || tooLong}
			onClick={!data?.id ? () => void generate() : undefined}
		>
			{data?.id ? "重新生成分析" : "生成完整语义分析"}
		</Button>
	);
	return (
		<section className="aa-panel" aria-label="完整语义分析">
			<div className="aa-header">
				<div>
					<h3>完整语义分析</h3>
					<p>理解整份回答，而不只看品牌是否出现。每个判断都可以定位原文。</p>
				</div>
				{data?.id ? (
					<Popconfirm
						title="按当前模型重新分析？"
						description="会产生新的模型调用并保留旧版分析，不修改原始证据或正式排名。"
						onConfirm={() => void generate()}
						disabled={Boolean(active) || loading || tooLong}
					>
						{action}
					</Popconfirm>
				) : (
					action
				)}
			</div>
			{error && (
				<Alert
					type="error"
					showIcon
					title={error}
					action={
						<PlainButton size="small" onClick={reload}>
							重新加载
						</PlainButton>
					}
				/>
			)}
			{loading && <Skeleton active paragraph={{ rows: 3 }} />}
			{!loading && data && (
				<>
					<div className="aa-toolbar">
						<Space wrap>
							<Tag color="default">{statuses[data.status]}</Tag>
							{history && <Tag color="default">历史分析 · 只读</Tag>}
							{data.previousRunId && (
								<PlainButton size="small" onClick={() => selectRun(data.previousRunId)}>
									上一版分析
								</PlainButton>
							)}
							{history && (
								<PlainButton size="small" onClick={() => selectRun(null)}>
									返回最新分析
								</PlainButton>
							)}
						</Space>
						<Space wrap>
							<PlainButton
								size="small"
								onClick={() => {
									setSelectedSpan(null);
									setSourceOpen(true);
								}}
							>
								对照完整原文
							</PlainButton>
							{data.result && (
								<PlainButton
									size="small"
									onClick={() =>
										downloadText(
											`answer-analysis-${capture.captureId}-${data.id}.json`,
											JSON.stringify(
												{
													captureId: capture.captureId,
													question: data.question,
													answer: capture.answerText,
													analysis: data,
												},
												null,
												2,
											),
											"application/json",
										)
									}
								>
									导出分析
								</PlainButton>
							)}
						</Space>
					</div>
					<AnalysisRunFeedback data={data} />
					{data.result && (
						<AnswerAnalysisContent
							result={data.result}
							brands={data.brands}
							onEvidence={(span) => {
								setSelectedSpan(span);
								setSourceOpen(true);
							}}
						/>
					)}
					<AnalysisMetadata data={data} />
				</>
			)}
			{tooLong && <Alert type="warning" showIcon title="原文过长，暂不支持全文分析。" />}
			<p className="aa-disclosure">
				此处是对已保存 AI 回答的语义解读，不是事实核验、人工审核或上游排序机制说明，不进入正式排名与漂移计算。
			</p>
			<Drawer title="语义判断与原文对照" open={sourceOpen} onClose={() => setSourceOpen(false)} size={720}>
				<p className="aa-source-question">{data?.question ?? capture.prompt}</p>
				{selectedSpan && (
					<Alert
						type="info"
						showIcon
						title={`已定位 ${selectedSpan.segmentId} 的对应引文`}
						description="请结合上下文核对高亮引文与分析结果。"
					/>
				)}
				<HighlightedAnswer answer={capture.answerText ?? ""} span={selectedSpan} markRef={mark} />
			</Drawer>
		</section>
	);
}
