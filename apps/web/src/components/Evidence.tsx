import { IconDownload, IconFileText, IconShieldCheck } from "@tabler/icons-react";
import { Collapse, Segmented } from "antd";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button, useBatch } from "../access";
import { type Capture, type Competitor, DEFAULT_PAGE_SIZE, type Project, providerIds, providerLabel, providerShortLabel } from "../types";
import { answerInline, FormattedAnswer } from "../ui/markdown";
import type { EvidenceFocus } from "../ui/navigation";
import {
	BatchPicker,
	csvCell,
	date,
	downloadText,
	Empty,
	FilterBar,
	IdChip,
	Notice,
	Pagination,
	shortDate,
} from "../ui/primitives";
import "./Evidence.css";
import { Page } from "./Page";

export { answerInline, FormattedAnswer };

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** 判定提及时用的品牌口径：客户品牌 id 就是项目 id（与指标口径一致），竞品取批次冻结配置。 */
type BrandScope = { customerId: string; customerName: string; competitors: Competitor[] };

/**
 * 回答里的品牌命中按“客户品牌 / 竞品”拆开，避免把竞品的位置当成客户品牌的提及位置。
 */
function summarizeMentions(capture: Capture, brands: BrandScope) {
	const own = capture.brandMatches.filter((match) => match.brandId === brands.customerId);
	const competitorNames = new Map<string, string>();
	for (const match of capture.brandMatches) {
		if (match.brandId === brands.customerId || competitorNames.has(match.brandId)) continue;
		const competitor = brands.competitors.find((item) => item.id === match.brandId);
		competitorNames.set(match.brandId, competitor?.name ?? match.matchedAlias);
	}
	const positions = [...new Set(own.map((match) => match.position))].sort((left, right) => left - right);
	return {
		mentioned: own.length > 0,
		count: own.length,
		positions,
		bestPosition: positions[0] ?? null,
		competitors: [...competitorNames.values()],
	};
}

export function Evidence({
	project,
	focus = null,
	onConsumeFocus,
}: {
	project: Project;
	focus?: EvidenceFocus;
	onConsumeFocus?(): void;
}) {
	const { selected, setSelected, batch } = useBatch(project, focus?.batchId ?? null);
	const [platform, setPlatform] = useState("all");
	const captures = useMemo(
		() => batch?.captures.filter((item) => platform === "all" || item.engine === platform) ?? [],
		[batch, platform],
	);
	const platformOptions = useMemo(
		() => [
			{ label: "全部", value: "all" },
			...[...new Set(batch?.config.platforms ?? providerIds)].map((id) => ({
				label: providerShortLabel(id),
				value: id,
			})),
		],
		[batch],
	);
	const [capturePage, setCapturePage] = useState(1);
	const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
	// 从报告/诊断的证据引用跳转过来时定位到具体回答。
	useEffect(() => {
		if (!focus || !batch) return;
		const index = batch.captures.findIndex((item) => item.captureId === focus.captureId);
		if (index === -1) {
			const owner = project.batches.find((item) => item.id !== batch.id && focus.batchId === item.id);
			if (owner) setSelected(owner.id);
			return;
		}
		setPlatform("all");
		setCapturePage(Math.floor(index / PAGE_SIZE) + 1);
		setActiveCaptureId(focus.captureId);
		onConsumeFocus?.();
	}, [focus, batch, project.batches, setSelected, onConsumeFocus]);
	const visibleCaptures = captures.slice((capturePage - 1) * PAGE_SIZE, capturePage * PAGE_SIZE);
	const activeCapture = captures.find((item) => item.captureId === activeCaptureId) ?? visibleCaptures[0] ?? null;
	const brands: BrandScope = {
		customerId: project.id,
		customerName: project.name,
		competitors: batch?.config.competitors ?? project.competitors,
	};
	function pickPlatform(value: string) {
		setPlatform(value);
		setCapturePage(1);
		setActiveCaptureId(null);
	}
	function exportCsv() {
		const headers = [
			"证据ID",
			"平台",
			"问题",
			"采样次数",
			"状态",
			"回答",
			"引用URL",
			"平台检索拆解",
			"原始响应",
			"模型",
			"协议",
			"请求ID",
			"成本(微美元)",
			"采集时间",
			"失败原因",
		];
		const rows = captures.map((capture) => [
			capture.captureId,
			capture.engine,
			capture.prompt,
			capture.attempt,
			capture.status,
			capture.answerText,
			capture.sources.map((source) => source.url).join("\n"),
			capture.queryFanOut.join("\n"),
			capture.evidence.rawResponseObjectKey
				? `/artifacts/${capture.evidence.rawResponseObjectKey}`
				: capture.evidence.screenshotObjectKey
					? `/artifacts/${capture.evidence.screenshotObjectKey}`
					: "",
			capture.model,
			capture.protocol,
			capture.evidence.requestId,
			capture.costMicros,
			capture.capturedAt,
			capture.failureMessage,
		]);
		downloadText(
			`${project.name}-${selected ?? "证据"}.csv`,
			`﻿${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
			"text/csv;charset=utf-8",
		);
	}
	if (!project.batches.length)
		return (
			<Page breadcrumb={project.name} eyebrow="证据中心" title="回答原文存证">
				<Empty title="还没有证据" detail="完成至少一个真实采集批次后，回答、来源和原始 API 响应会出现在这里。" />
			</Page>
		);
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="证据中心"
			title="回答原文存证"
			description="原始回答与 API 响应写入后不可修改。"
			extra={
				<Button variant="secondary" icon={<IconDownload size={16} />} disabled={!captures.length} onClick={exportCsv}>
					导出证据 CSV
				</Button>
			}
		>
			<FilterBar extra={<span className="evidence-count">{captures.length ? `${captures.length} 条回答` : ""}</span>}>
				<BatchPicker
					project={project}
					selected={selected}
					setSelected={(id) => {
						setSelected(id);
						setCapturePage(1);
						setActiveCaptureId(null);
					}}
				/>
				<Segmented options={platformOptions} value={platform} onChange={(value) => pickPlatform(String(value))} />
			</FilterBar>
			{captures.length === 0 ? (
				<Empty title="批次尚无采集结果" detail="云端 Worker 可能仍在等待分时窗口，或平台配置需要处理。" />
			) : (
				<div className="evidence-layout">
					<div className="evidence-list">
						{visibleCaptures.map((capture) => {
							const mention = summarizeMentions(capture, brands);
							return (
								<button
									type="button"
									className={`evidence-card ${activeCapture?.captureId === capture.captureId ? "selected" : ""}`}
									key={capture.captureId}
									onClick={() => setActiveCaptureId(capture.captureId)}
								>
									<span className="evidence-card-head">
										<span className="ev-platform">{providerShortLabel(capture.engine)}</span>
										<span className="ev-meta">
											第 {capture.attempt} 次 · {shortDate(capture.capturedAt)}
										</span>
									</span>
									<strong>{capture.prompt}</strong>
									<span className={`ev-result ${capture.status === "complete" ? "ok" : "fail"}`}>
										{capture.status === "complete"
											? mention.mentioned
												? `提及客户品牌 · 位置 ${mention.bestPosition}`
												: mention.competitors.length
													? `未提及客户品牌 · 仅竞品 ${mention.competitors.join("、")}`
													: "未提及客户品牌"
											: `采集失败 · ${capture.failureMessage ?? capture.status}`}
									</span>
								</button>
							);
						})}
						<Pagination
							page={capturePage}
							pageSize={PAGE_SIZE}
							total={captures.length}
							totalPages={Math.max(1, Math.ceil(captures.length / PAGE_SIZE))}
							onPage={(page) => {
								setCapturePage(page);
								setActiveCaptureId(null);
							}}
						/>
					</div>
					<div className="evidence-detail-pane">
						{activeCapture ? (
							<EvidenceDetail capture={activeCapture} brands={brands} />
						) : (
							<Empty compact title="选择一条回答" detail="左侧点击任意回答查看原文、来源和原始响应。" />
						)}
					</div>
				</div>
			)}
		</Page>
	);
}

type EvidencePanel = { key: string; label: string; children: ReactNode };

function answerPanel(answerText: string): EvidencePanel {
	return {
		key: "answer",
		label: `回答原文（${answerText.length} 字）`,
		children: (
			<div className="ed-answer-scroll">
				<FormattedAnswer value={answerText} />
			</div>
		),
	};
}

function hasRawEvidence(capture: Capture): boolean {
	return (
		capture.sources.length > 0 ||
		capture.queryFanOut.length > 0 ||
		Boolean(capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey)
	);
}

function RawEvidencePanel({ capture }: { capture: Capture }) {
	return (
		<>
			{capture.sources.length > 0 && (
				<div className="sources">
					<b>引用来源</b>
					{capture.sources.map((source) => (
						<a href={source.url} target="_blank" rel="noreferrer" key={`${source.position}-${source.url}`}>
							{source.position}. {source.title ?? source.domain}
						</a>
					))}
				</div>
			)}
			{capture.sourceVisibility === "unavailable" && (
				<p className="muted">该平台本次未开放来源数据，引用率记为不可用，不按 0 计算。</p>
			)}
			{capture.queryFanOut.length > 0 && (
				<div className="query-fanout">
					<b>平台检索拆解</b>
					<div>
						{capture.queryFanOut.map((query) => (
							<span key={query}>{query}</span>
						))}
					</div>
				</div>
			)}
			{(capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey) && (
				<a
					className="screenshot-link"
					href={`/artifacts/${capture.evidence.rawResponseObjectKey ?? capture.evidence.screenshotObjectKey}`}
					target="_blank"
					rel="noreferrer"
				>
					<IconFileText size={16} />
					{capture.captureMode === "llm_search_api" ? "查看原始 API 响应" : "查看历史页面截图"}
				</a>
			)}
		</>
	);
}

export function EvidenceDetail({ capture, brands }: { capture: Capture; brands: BrandScope }) {
	const mention = summarizeMentions(capture, brands);
	const panels: EvidencePanel[] = [];
	if (capture.answerText) panels.push(answerPanel(capture.answerText));
	if (hasRawEvidence(capture))
		panels.push({
			key: "raw",
			label: `引用来源与平台检索拆解（来源 ${capture.sources.length} 条）`,
			children: <RawEvidencePanel capture={capture} />,
		});
	return (
		<article className="evidence-detail">
			<div className="ed-head">
				<div className="ed-head-text">
					<span className="ev-platform">{providerLabel(capture.engine)}</span>
					<strong>{capture.prompt}</strong>
					<span className="ed-time">
						采集于 {date(capture.capturedAt)} · 第 {capture.attempt} 次采样 · {capture.model ?? "历史页面"} ·{" "}
						{capture.protocol ?? capture.captureMode}
					</span>
				</div>
				<div className="ed-ids">
					<IdChip value={capture.captureId} label="证据" />
					{capture.evidence.requestId && (
						<span className="ed-hash" title="供应商请求 ID，用于向平台追溯本次回答">
							<IconShieldCheck size={12} />
							<IdChip value={capture.evidence.requestId} label="请求" length={10} />
						</span>
					)}
				</div>
			</div>
			{capture.answerText ? (
				<Collapse className="ed-collapse" defaultActiveKey={["answer"]} items={panels} />
			) : (
				<Notice type="error" message={capture.failureMessage ?? "本次采集没有回答"} />
			)}
			<div className="ed-foot">
				<span className="ed-status">
					结论：
					{capture.status === "complete"
						? mention.mentioned
							? `${brands.customerName} 被提及 ${mention.count} 次`
							: `回答未提及 ${brands.customerName}`
						: (capture.failureMessage ?? "本次采集未完成")}
				</span>
				<span className="ed-tags">
					{mention.mentioned ? `提及位置 ${mention.positions.join("、")}` : "未提及"}
					{mention.competitors.length > 0 ? ` · 同时出现竞品 ${mention.competitors.join("、")}` : ""}
					{capture.sources.length > 0 ? ` · 引用来源 ${capture.sources.length} 条` : ""}
					{capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey ? " · 原文已存证" : ""}
				</span>
			</div>
		</article>
	);
}
