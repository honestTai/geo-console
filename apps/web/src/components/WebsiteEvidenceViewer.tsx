import { Alert, Drawer } from "antd";
import { useEffect, useState } from "react";
import { Button } from "../access";
import { api } from "../api";
import type { WebsiteAuditRecord } from "../types";
import { BrandLoading } from "../ui/BrandLoading";
import { date, IdChip } from "../ui/primitives";
import { AuditEvidenceDrawer } from "./WebsiteAudit";

type WebsiteEvidence =
	| { kind: "audit"; audit: WebsiteAuditRecord }
	| {
			kind: "snapshot";
			snapshot: {
				id: string;
				url: string;
				title: string | null;
				content_text: string;
				structured_data: unknown;
				content_hash: string;
				artifact_key: string | null;
				fetched_at: string;
			};
	  };
export function WebsiteEvidenceViewer({
	projectId,
	evidenceId,
	onClose,
}: {
	projectId: string;
	evidenceId: string;
	onClose(): void;
}) {
	const [record, setRecord] = useState<WebsiteEvidence | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setRecord(null);
		setError(null);
		api<WebsiteEvidence>(
			`/api/projects/${encodeURIComponent(projectId)}/website-evidence/${encodeURIComponent(evidenceId)}`,
			{ signal: controller.signal },
		)
			.then((value) => {
				if (!controller.signal.aborted) setRecord(value);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "证据读取失败");
			});
		return () => controller.abort();
	}, [projectId, evidenceId]);
	if (record?.kind === "audit") return <AuditEvidenceDrawer audit={record.audit} detail="all" onClose={onClose} />;
	return (
		<Drawer open onClose={onClose} title="官网原始证据" size="min(880px, 100vw)">
			<div className="audit-evidence-detail">
				{error ? (
					<Alert showIcon type="error" title={error} />
				) : !record ? (
					<BrandLoading label="正在读取官网证据" />
				) : (
					<>
						<h3>{record.snapshot.title ?? "网页快照"}</h3>
						<p>{record.snapshot.url}</p>
						<p>
							取证时间：{date(record.snapshot.fetched_at)} · <IdChip value={record.snapshot.id} label="编号" />
						</p>
						<p>
							<IdChip value={record.snapshot.content_hash} label="SHA-256" length={12} />
						</p>
						{record.snapshot.artifact_key && (
							<Button
								variant="secondary"
								href={`/artifacts/${record.snapshot.artifact_key.split("/").map(encodeURIComponent).join("/")}`}
								target="_blank"
								rel="noopener noreferrer"
							>
								打开 / 下载原始 HTML
							</Button>
						)}
						<Alert
							showIcon
							type="info"
							title="这是当时保存的网页文本快照，不是实时页面；旧记录不补写截图。新官网审计包含独立的截图证据。"
						/>
						<h3>保存的正文</h3>
						<pre>{record.snapshot.content_text}</pre>
						<h3>结构化数据</h3>
						<pre>{JSON.stringify(record.snapshot.structured_data, null, 2)}</pre>
					</>
				)}
			</div>
		</Drawer>
	);
}
