import { IconShieldCheck } from "@tabler/icons-react";
import { Alert, Descriptions, Statistic, Tabs, Tag } from "antd";
import { useMemo, useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { AuditCheck, Project } from "../types";
import { date, Empty } from "../ui/primitives";
import { Page } from "./Page";
import "./WebsiteAudit.css";

const verdictMeta: Record<string, { label: string; color: string }> = {
	ready: { label: "官网读取基础完整", color: "green" },
	ready_with_warnings: { label: "官网可读取，但存在重要缺口", color: "orange" },
	blocked: { label: "官网存在读取阻断", color: "red" },
};

const checkStatusMeta: Record<AuditCheck["status"], { label: string; color: string }> = {
	pass: { label: "通过", color: "green" },
	fail: { label: "失败", color: "red" },
	warning: { label: "警告", color: "orange" },
	skip: { label: "参考", color: "default" },
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
	const checkTabs = useMemo(() => {
		if (!audit) return [];
		const groups = new Map<string, AuditCheck[]>();
		for (const check of audit.result.checks) {
			const label = checkGroupLabel(check);
			groups.set(label, [...(groups.get(label) ?? []), check]);
		}
		return [...groups.entries()].map(([label, checks]) => ({
			key: label,
			label: `${label}（${checks.length}）`,
			checks: [...checks].sort((a, b) => checkStatusRank[a.status] - checkStatusRank[b.status]),
		}));
	}, [audit]);
	const defaultTabKey =
		checkTabs.find((tab) => tab.checks.some((check) => check.status === "fail" || check.status === "warning"))?.key ??
		checkTabs[0]?.key;
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
	const verdict = verdictMeta[audit.result.verdict];
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
					<Tag color={verdict.color}>{verdict.label}</Tag>
					<p className="muted">
						最近审计：{date(audit.result.checkedAt)} · {audit.result.checks.length} 项检查 · 审计证据 ID {audit.id}
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
			<header className="audit-checks-head">
				<h3>审计项目</h3>
				<span className="muted">
					通过 {passCount} / 共 {audit.result.checks.length} 项
				</span>
			</header>
			<Tabs
				defaultActiveKey={defaultTabKey}
				items={checkTabs.map((tab) => ({
					key: tab.key,
					label: tab.label,
					children: (
						<div className="audit-check-grid">
							{tab.checks.map((check) => (
								<article className={`audit-check-card ${check.status}`} key={check.id}>
									<Tag color={checkStatusMeta[check.status].color}>{checkStatusMeta[check.status].label}</Tag>
									<strong>{check.label}</strong>
									<p>{check.detail}</p>
								</article>
							))}
						</div>
					),
				}))}
			/>
		</Page>
	);
}
