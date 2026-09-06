import type { AnswerAnalysisView } from "@geo/evidence";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "完整语义分析请求失败");

/** Sequential, abortable polling. Switching evidence must never show another answer's analysis. */
export function useAnswerAnalysis(batchId: string, captureId: string) {
	const path = `/api/batches/${encodeURIComponent(batchId)}/captures/${encodeURIComponent(captureId)}/analysis`;
	const [runId, setRunId] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [data, setData] = useState<AnswerAnalysisView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const writeController = useRef<AbortController | null>(null);
	const readPath = `${path}?${new URLSearchParams({ ...(runId ? { runId } : {}), readRevision: String(revision) })}`;
	useEffect(() => () => writeController.current?.abort(), []);
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		setData(null);
		setError(null);
		setLoading(true);
		async function load() {
			try {
				const result = await api<AnswerAnalysisView>(readPath, {
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setData(result);
				setError(null);
				if (["queued", "running"].includes(result.status)) timer = setTimeout(() => void load(), 2500);
			} catch (e) {
				if (!controller.signal.aborted) setError(errorMessage(e));
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		}
		void load();
		return () => {
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [readPath]);
	async function generate() {
		if (writeController.current && !writeController.current.signal.aborted && busy) return;
		const controller = new AbortController();
		writeController.current = controller;
		setBusy(true);
		setError(null);
		try {
			const result = await api<{ id: string }>(path, { method: "POST", body: "{}", signal: controller.signal });
			if (!controller.signal.aborted) {
				setRunId(result.id);
				setRevision((value) => value + 1);
			}
		} catch (e) {
			if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "完整语义分析请求失败");
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return { data, error, loading, busy, generate, selectRun: setRunId, reload: () => setRevision((value) => value + 1) };
}
