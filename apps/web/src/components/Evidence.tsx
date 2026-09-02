import { IconDownload, IconFileText, IconShieldCheck } from "@tabler/icons-react";
import { Collapse, Segmented } from "antd";
import { type ReactNode, useMemo, useState } from "react";
import { Button, useBatch } from "../access";
import { type Capture, type Project, providerIds, providerLabel } from "../types";
import { BatchPicker, csvCell, date, downloadText, Empty, Notice, Pagination } from "../ui/primitives";
import "./Evidence.css";
import { Page } from "./Page";

export function Evidence({ project }: { project: Project }) {
	const { selected, setSelected, batch } = useBatch(project);
	const [platform, setPlatform] = useState("all");
	const captures = useMemo(
		() => batch?.captures.filter((item) => platform === "all" || item.engine === platform) ?? [],
		[batch, platform],
	);
	const platformOptions = useMemo(
		() => [
			{ label: "全部", value: "all" },
			...[...new Set(batch?.config.platforms ?? providerIds)].map((id) => ({ label: providerLabel(id), value: id })),
		],
		[batch],
	);
	const [capturePage, setCapturePage] = useState(1);
	const visibleCaptures = captures.slice((capturePage - 1) * 10, capturePage * 10);
	const [activeCaptureId, setActiveCaptureId] = useState<string | null>(null);
	const activeCapture =
		visibleCaptures.find((item) => item.captureId === activeCaptureId) ?? visibleCaptures[0] ?? null;
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
			`\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
			"text/csv;charset=utf-8",
		);
	}
	if (!project.batches.length)
		return <Empty title="还没有证据" detail="完成至少一个真实采集批次后，回答、来源和原始 API 响应会出现在这里。" />;
	return (
		<Page
			breadcrumb={project.name}
			eyebrow="证据中心"
			title="回答原文存证"
			description="原始回答与 API 响应写入后不可修改；派生指标可以按新规则重算。"
			extra={
				<div className="filters">
					<BatchPicker
						project={project}
						selected={selected}
						setSelected={(id) => {
							setSelected(id);
							setCapturePage(1);
							setActiveCaptureId(null);
						}}
					/>
					<Button variant="secondary" icon={<IconDownload size={16} />} disabled={!captures.length} onClick={exportCsv}>
						导出证据 CSV
					</Button>
				</div>
			}
		>
			<div className="evidence-filter">
				<Segmented options={platformOptions} value={platform} onChange={(value) => pickPlatform(String(value))} />
			</div>
			{captures.length === 0 ? (
				<Empty title="批次尚无采集结果" detail="云端 Worker 可能仍在等待分时窗口，或平台配置需要处理。" />
			) : (
				<>
					<div className="evidence-grid">
						{visibleCaptures.map((capture) => (
							<button
								type="button"
								className={`evidence-card ${activeCapture?.captureId === capture.captureId ? "selected" : ""}`}
								key={capture.captureId}
								onClick={() => setActiveCaptureId(capture.captureId)}
							>
								<span className="ev-platform">{providerLabel(capture.engine)}</span>
								<strong>“{capture.prompt}”</strong>
								<span className="ev-meta">
									{capture.status === "success" ? "有回答" : capture.status} · 第 {capture.attempt} 次采样 ·{" "}
									{date(capture.capturedAt)}
								</span>
							</button>
						))}
					</div>
					<Pagination
						page={capturePage}
						pageSize={10}
						total={captures.length}
						totalPages={Math.max(1, Math.ceil(captures.length / 10))}
						onPage={(page) => {
							setCapturePage(page);
							setActiveCaptureId(null);
						}}
					/>
					{activeCapture && <EvidenceDetail capture={activeCapture} />}
				</>
			)}
		</Page>
	);
}

export function answerInline(value: string, keyPrefix: string): ReactNode[] {
	const pattern = /(\*\*[^*]+\*\*|`[^`]+`|!?\[[^\]]*\]\(https?:\/\/[^\s)]+\))/g;
	const parts: ReactNode[] = [];
	let offset = 0;
	for (const [index, match] of [...value.matchAll(pattern)].entries()) {
		const token = match[0];
		const start = match.index ?? 0;
		if (start > offset) parts.push(value.slice(offset, start));
		if (token.startsWith("**")) parts.push(<strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>);
		else if (token.startsWith("`")) parts.push(<code key={`${keyPrefix}-c-${index}`}>{token.slice(1, -1)}</code>);
		else {
			const image = token.startsWith("!");
			const link = token.match(/^!?\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/);
			if (link)
				parts.push(
					<a key={`${keyPrefix}-a-${index}`} href={link[2]} target="_blank" rel="noreferrer">
						{image ? `图片：${link[1] || link[2]}` : link[1] || link[2]}
					</a>,
				);
			else parts.push(token);
		}
		offset = start + token.length;
	}
	if (offset < value.length) parts.push(value.slice(offset));
	return parts;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: A single pass keeps Markdown block precedence explicit without injecting HTML.
export function FormattedAnswer({ value }: { value: string }) {
	const lines = value.replaceAll("\r\n", "\n").split("\n");
	const blocks: ReactNode[] = [];
	for (let index = 0; index < lines.length; ) {
		const line = lines[index]?.trimEnd() ?? "";
		if (!line.trim()) {
			index += 1;
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			const level = Math.min(4, heading[1].length + 1);
			const content = answerInline(heading[2], `h-${index}`);
			blocks.push(
				level === 2 ? (
					<h2 key={`h-${index}`}>{content}</h2>
				) : level === 3 ? (
					<h3 key={`h-${index}`}>{content}</h3>
				) : (
					<h4 key={`h-${index}`}>{content}</h4>
				),
			);
			index += 1;
			continue;
		}
		if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
			blocks.push(<hr key={`hr-${index}`} />);
			index += 1;
			continue;
		}
		if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) {
			const rows: string[][] = [];
			const header = line
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim());
			index += 2;
			while (index < lines.length && (lines[index] ?? "").includes("|")) {
				rows.push(
					(lines[index] ?? "")
						.replace(/^\||\|$/g, "")
						.split("|")
						.map((cell) => cell.trim()),
				);
				index += 1;
			}
			blocks.push(
				<div className="answer-table-wrap" key={`table-${index}`}>
					<table>
						<thead>
							<tr>
								{header.map((cell, cellIndex) => (
									<th key={cell}>{answerInline(cell, `th-${index}-${cellIndex}`)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, rowIndex) => (
								<tr key={row.join("|")}>
									{row.map((cell, cellIndex) => (
										<td key={cell}>{answerInline(cell, `td-${rowIndex}-${cellIndex}`)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}
		const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
		if (listMatch) {
			const ordered = /^\s*\d/.test(line);
			const items: string[] = [];
			while (index < lines.length) {
				const item = (lines[index] ?? "").match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
				if (!item || /^\s*\d/.test(lines[index] ?? "") !== ordered) break;
				items.push(item[1]);
				index += 1;
			}
			const children = items.map((item, itemIndex) => (
				<li key={item}>{answerInline(item, `li-${index}-${itemIndex}`)}</li>
			));
			blocks.push(ordered ? <ol key={`ol-${index}`}>{children}</ol> : <ul key={`ul-${index}`}>{children}</ul>);
			continue;
		}
		const paragraph: string[] = [line.trim()];
		index += 1;
		while (
			index < lines.length &&
			(lines[index] ?? "").trim() &&
			!/^#{1,6}\s+/.test(lines[index] ?? "") &&
			!/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index] ?? "") &&
			!((lines[index] ?? "").includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? ""))
		) {
			paragraph.push((lines[index] ?? "").trim());
			index += 1;
		}
		blocks.push(<p key={`p-${index}`}>{answerInline(paragraph.join(" "), `p-${index}`)}</p>);
	}
	return <div className="formatted-answer">{blocks}</div>;
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

export function EvidenceDetail({ capture }: { capture: Capture }) {
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
				<span className="ev-platform">{providerLabel(capture.engine)}</span>
				<div>
					<strong>“{capture.prompt}”</strong>
					<span className="ed-time">
						采集于 {date(capture.capturedAt)} · 第 {capture.attempt} 次采样 · {capture.model ?? "历史页面"} ·{" "}
						{capture.protocol ?? capture.captureMode} · 证据ID {capture.captureId}
					</span>
				</div>
				{capture.evidence.requestId && (
					<span className="ed-hash" title="证据请求 ID，用于校验完整性">
						<IconShieldCheck size={12} />
						<code>{capture.evidence.requestId}</code>
					</span>
				)}
			</div>
			{capture.answerText ? (
				<Collapse className="ed-collapse" defaultActiveKey={["answer"]} items={panels} />
			) : (
				<Notice type="error" message={capture.failureMessage ?? "本次采集没有回答"} />
			)}
			<div className="ed-foot">
				<span className="ed-status">
					结论：
					{capture.status === "success"
						? capture.brandMatches.length > 0
							? `品牌被提及 ${capture.brandMatches.length} 次`
							: "回答未提及品牌"
						: (capture.failureMessage ?? "本次采集未完成")}
				</span>
				<span className="ed-tags">
					{capture.brandMatches.length > 0
						? `提及位置 ${capture.brandMatches.map((match) => match.position).join("、")}`
						: "未提及"}
					{capture.sources.length > 0 ? ` · 引用来源 ${capture.sources.length} 条` : ""}
					{capture.evidence.rawResponseObjectKey || capture.evidence.screenshotObjectKey ? " · 截图 + 原文已存证" : ""}
				</span>
			</div>
		</article>
	);
}
