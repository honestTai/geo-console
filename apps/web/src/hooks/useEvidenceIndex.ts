import { useEffect, useState } from "react";
import { api } from "../api";
import type { EvidenceIndexEntry, Paginated, ReportPayload, WebSearchRecord } from "../types";

/** 联网搜索记录 → 证据索引条目：不参与报告编号（n=0），引用显示为“[联网] 检索问题”。 */
export function webSearchIndexEntry(record: WebSearchRecord): EvidenceIndexEntry {
	return {
		n: 0,
		id: record.id,
		kind: "web_search",
		platform: null,
		platformLabel: "联网搜索",
		question: record.query,
		attempt: null,
		status: record.status,
		capturedAt: record.created_at,
		sourceUrls: record.sources.map((source) => source.url).slice(0, 12),
		url: null,
		title: null,
	};
}

/**
 * 证据索引：把草稿/诊断里的证据 UUID 翻译成 “[n] 平台 · 问题”。
 * 批次索引来自该批次的报告分析（没有报告分析时为空）；传入 projectId 时再合并本项目成功的联网搜索记录，
 * 这样引用联网证据的草稿也能显示可读标题并跳到证据中心。缺失的 ID 退化为短 ID 芯片。
 */
export function useEvidenceIndex(batchId: string | null | undefined, projectId?: string | null): EvidenceIndexEntry[] {
	const [batchIndex, setBatchIndex] = useState<EvidenceIndexEntry[]>([]);
	const [webIndex, setWebIndex] = useState<EvidenceIndexEntry[]>([]);
	useEffect(() => {
		if (!batchId) {
			setBatchIndex([]);
			return;
		}
		let current = true;
		api<ReportPayload>(`/api/batches/${batchId}/report`)
			.then((payload) => {
				if (current) setBatchIndex(payload.analysis?.evidenceIndex ?? []);
			})
			.catch(() => {
				if (current) setBatchIndex([]);
			});
		return () => {
			current = false;
		};
	}, [batchId]);
	useEffect(() => {
		if (!projectId) {
			setWebIndex([]);
			return;
		}
		let current = true;
		api<Paginated<WebSearchRecord>>(`/api/projects/${projectId}/web-searches?pageSize=100&status=complete`)
			.then((page) => {
				if (current) setWebIndex(page.items.map(webSearchIndexEntry));
			})
			.catch(() => {
				if (current) setWebIndex([]);
			});
		return () => {
			current = false;
		};
	}, [projectId]);
	return webIndex.length ? [...batchIndex, ...webIndex] : batchIndex;
}
