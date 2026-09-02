import { IconShieldCheck } from "@tabler/icons-react";
import { Alert, Descriptions, Statistic, Tag } from "antd";
import { useMemo, useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { AuditCheck, Project } from "../types";
import { date, Empty, IdChip, SectionTitle } from "../ui/primitives";
import { Page } from "./Page";
import "./WebsiteAudit.css";

const verdictLabels: Record<string, string> = {
	ready: "官网读取基础完整",
	ready_with_warnings: "官网可读取，但存在重要缺口",
	blocked: "官网存在读取阻断",
};

const checkStatusLabels: Record<AuditCheck["status"], string> = {
	pass: "通过",
	fail: "失败",
	warning: "警告",
	skip: "参考",
};

const checkStatusRank: Record<AuditCheck["status"], number> = { fail: 0, warning: 1, skip: 2, pass: 3 };

function checkGroupLabel(check: AuditCheck): string {
	const order = Number.parseInt(check.id.replace(/\D/g, ""), 10);
	if (order <= 4) return "可访问性";
	if (order <= 9) return "内容与结构";
	if (order <= 12) return "实体与信号";
	return "可选项目";
}

export function WebsiteAudit({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const audit = project.websiteAudits?.[0];
	const sortedChecks = useMemo(
		() => (audit ? [...audit.result.checks].sort((a, b) => checkStatusRank[a.status] - checkStatusRank[b.status]) : []),
		[audit],
	);
	async function run() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/audit`);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "官网审计失败");
		} finally {
			setBusy(false);
		}
	}
	if (!audit)
		return (
			<Page
				className="audit-page"
				breadcrumb={project.name}
				eyebrow="官网审计"
				title="公开页面的 AI 可读性检查"
				description="检查 AI 与搜索系统能否稳定读取官网，以及页面是否提供可理解、可引用的实体和事实结构。"
				extra={
					<Button permission="audit.run" busy={busy} icon={<IconShieldCheck size={17} />} onClick={run}>
						开始真实审计
					</Button>
				}
			>
				{error && <Alert type="error" showIcon message={error} />}
				<Empty
					title="还没有官网审计证据"
					detail="运行后会真实请求客户官网、robots.txt、Sitemap 和 llms.txt，并保存不可变审计快照。"
				/>
			</Page>
		);
	const passCount = audit.result.checks.filter((check) => check.status === "pass").length;
	const verdictLabel = verdictLabels[audit.result.verdict] ?? audit.result.verdict;
	return (
		<Page
			className="audit-page"
			breadcrumb={project.name}
			eyebrow="官网审计"
			title="公开页面的 AI 可读性检查"
			description="检查 AI 与搜索系统能否稳定读取官网，以及页面是否提供可理解、可引用的实体和事实结构。"
			extra={
				<Button permission="audit.run" busy={busy} icon={<IconShieldCheck size={17} />} onClick={run}>
					重新审计
				</Button>
			}
		>
			{error && <Alert type="error" showIcon message={error} />}
			<div className="audit-hero">
				<Statistic title="AI 可读性得分" value={audit.result.score} suffix="/ 100" />
				<div className="audit-hero-text">
					<Tag>{verdictLabel}</Tag>
					<p className="muted">
						最近审计：{date(audit.result.checkedAt)} · {audit.result.checks.length} 项检查{" "}
						<IdChip value={audit.id} label="审计证据" />
					</p>
				</div>
			</div>
			{!audit.result.transport.https.ok &&
				(audit.result.transport.httpFallback.ok || audit.result.transport.browserFallback.ok) && (
					<Alert
						type="warning"
						showIcon
						message="HTTPS 校验失败，普通浏览器方式仍能读取页面。系统用可访问内容完成结构检查；这不代表 HTTPS 或机器人访问问题已通过。"
					/>
				)}
			<SectionTitle title="首页读取结果" />
			<Descriptions
				bordered
				size="small"
				column={{ xs: 1, lg: 2 }}
				items={[
					{ key: "title", label: "页面标题", children: audit.result.homepage.title ?? "未检测到" },
					{ key: "canonical", label: "Canonical", children: audit.result.homepage.canonical ?? "未声明" },
					{
						key: "headings",
						label: "标题结构",
						children: `H1 ${audit.result.homepage.h1Count} · H2 ${audit.result.homepage.h2Count}`,
					},
					{
						key: "structured",
						label: "结构化数据",
						children: audit.result.homepage.structuredDataTypes.join("、") || "未检测到",
					},
					{
						key: "https",
						label: "HTTPS",
						children: audit.result.transport.https.ok ? "正常" : "异常",
					},
					{ key: "sitemap", label: "Sitemap", children: `${audit.result.discovery.sitemap.urlCount} 个 URL` },
					{ key: "jsonld", label: "JSON-LD", children: `${audit.result.homepage.structuredDataTypes.length || 0} 类` },
				]}
			/>
			<SectionTitle
				title="审计项目"
				count={`通过 ${passCount} / ${audit.result.checks.length}`}
				description="失败与警告项排在前面；参考项不影响得分。"
			/>
			<div className="audit-check-grid">
				{sortedChecks.map((check) => (
					<article className={`audit-check-card ${check.status}`} key={check.id}>
						<Tag>{checkStatusLabels[check.status]}</Tag>
						<div className="audit-check-body">
							<span className="audit-check-category">{checkGroupLabel(check)}</span>
							<strong>{check.label}</strong>
							<p>{check.detail}</p>
						</div>
					</article>
				))}
			</div>
		</Page>
	);
}
