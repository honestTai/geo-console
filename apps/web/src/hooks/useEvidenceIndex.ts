import { useEffect, useState } from "react";
import { api } from "../api";
import type { EvidenceIndexEntry, ReportPayload } from "../types";

/**
 * 某个批次的证据索引：把草稿/诊断里的证据 UUID 翻译成 “[n] 平台 · 问题”。
 * 批次还没有报告分析时返回空数组，引用会退化为短 ID 芯片。
 */
export function useEvidenceIndex(batchId: string | null | undefined): EvidenceIndexEntry[] {
	const [index, setIndex] = useState<EvidenceIndexEntry[]>([]);
	useEffect(() => {
		if (!batchId) {
			setIndex([]);
			return;
		}
		let current = true;
		api<ReportPayload>(`/api/batches/${batchId}/report`)
			.then((payload) => {
				if (current) setIndex(payload.analysis?.evidenceIndex ?? []);
			})
			.catch(() => {
				if (current) setIndex([]);
			});
		return () => {
			current = false;
		};
	}, [batchId]);
	return index;
}
