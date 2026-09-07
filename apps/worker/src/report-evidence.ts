import type { Database, WebsiteAuditResult } from "@geo/core";
import type { ReportAnalysis } from "./report";
import { HttpInputError, parseJsonColumn } from "./utils";

export type SupplementalEvidence = {
	id: string;
	kind: "snapshot" | "web_search" | "audit";
	title: string;
	url: string | null;
	content: string;
	sourceUrls: string[];
	capturedAt: string;
	audit?: WebsiteAuditResult;
};

/** A report must freeze every approved reference, not just the latest crawled pages. */
export async function freezeReferencedEvidence(
	database: Database,
	projectId: string,
	analysis: ReportAnalysis,
	ids: string[],
) {
	const known = new Set(analysis.evidenceIndex.map((e) => e.id));
	const missing = [...new Set(ids)].filter((id) => !known.has(id));
	const supplemental: SupplementalEvidence[] = [];
	if (!missing.length) return;
	const pages = (
		await database.query<{ id: string; url: string; title: string | null; content_text: string; fetched_at: string }>(
			"SELECT id,url,title,content_text,fetched_at FROM website_snapshots WHERE project_id=$1 AND id=ANY($2::text[])",
			[projectId, missing],
		)
	).rows;
	for (const r of pages)
		supplemental.push({
			id: r.id,
			kind: "snapshot",
			title: r.title ?? "保存的网页",
			url: r.url,
			content: r.content_text,
			sourceUrls: [],
			capturedAt: r.fetched_at,
		});
	const searches = (
		await database.query<{
			id: string;
			query: string;
			answer_text: string | null;
			sources: unknown;
			created_at: string;
		}>(
			"SELECT id,query,answer_text,sources,created_at FROM web_search_evidence WHERE project_id=$1 AND id=ANY($2::text[])",
			[projectId, missing],
		)
	).rows;
	for (const r of searches)
		supplemental.push({
			id: r.id,
			kind: "web_search",
			title: `研究搜索：${r.query}`,
			url: null,
			content: r.answer_text ?? "未返回研究回答",
			sourceUrls: parseJsonColumn<Array<{ url: string }>>(r.sources as string | Array<{ url: string }>).map(
				(s) => s.url,
			),
			capturedAt: r.created_at,
		});
	const audits = (
		await database.query<{ id: string; result: unknown; checked_at: string }>(
			"SELECT id,result,checked_at FROM website_audits WHERE project_id=$1 AND id=ANY($2::text[])",
			[projectId, missing],
		)
	).rows;
	for (const r of audits) {
		const audit = parseJsonColumn<WebsiteAuditResult>(r.result as string | WebsiteAuditResult);
		supplemental.push({
			id: r.id,
			kind: "audit",
			title: "被引用的历史官网检查",
			url: audit.requestedUrl,
			content: "",
			sourceUrls: [],
			capturedAt: r.checked_at,
			audit,
		});
	}
	const unresolved = missing.filter((id) => !supplemental.some((e) => e.id === id));
	if (unresolved.length)
		throw new HttpInputError("部分已引用证据无法在本客户与本批次中找到，不能生成无法复核的报告；请先核对报告引用", 409);
	analysis.supplementalEvidence = supplemental;
	for (const e of supplemental)
		analysis.evidenceIndex.push({
			n: analysis.evidenceIndex.length + 1,
			id: e.id,
			kind: e.kind,
			platform: null,
			platformLabel:
				e.kind === "web_search" ? "研究搜索记录（不是监测回答）" : e.kind === "audit" ? "历史官网检查" : "网页快照",
			question: null,
			attempt: null,
			status: null,
			capturedAt: e.capturedAt,
			sourceUrls: [],
			url: e.url,
			title: e.title,
		});
}
