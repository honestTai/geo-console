import { websiteCheckLanguage, websiteScoreBreakdown, websiteScoreGuide } from "@geo/evidence";
import { IconShieldCheck } from "@tabler/icons-react";
import { Alert, Descriptions, Drawer, Image, Select, Statistic, Tag } from "antd";
import { useMemo, useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { AuditCheck, Project, WebsiteAuditRecord } from "../types";
import { MetricLabel } from "../ui/MetricLabel";
import { date, Empty, IdChip, SectionTitle } from "../ui/primitives";
import { Page } from "./Page";
import { ProjectProfileEditor } from "./ProjectProfileEditor";
import "./WebsiteAudit.css";

const verdictLabels: Record<string, string> = {
	ready: "基础检查通过",
	ready_with_warnings: "可读取，部分项目需处理",
	blocked: "部分内容无法读取",
};
const scoreDescription = (result: WebsiteAuditRecord["result"]) =>
	result.score === null ? "缺少评分证据，不记为零分" : websiteScoreBreakdown(result.checks);

const checkStatusLabels: Record<AuditCheck["status"], string> = {
	pass: "通过",
	fail: "失败",
	warning: "警告",
	skip: "参考",
};

const checkStatusRank: Record<AuditCheck["status"], number> = { fail: 0, warning: 1, skip: 2, pass: 3 };
const sourceKinds: Record<string, string> = {
	homepage: "首页源码",
	robots: "抓取规则",
	sitemap: "XML 站点地图",
	llms: "模型读取说明",
	screenshot: "首页截图",
	report: "审计报告",
};
const sitemapKinds: Record<string, string> = {
	urlset: "XML 页面清单",
	index: "XML 索引",
	html: "HTML 页面",
	invalid: "非有效 Sitemap",
	unavailable: "未读取成功",
};

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
	const [selectedAudit, setSelectedAudit] = useState<string | null>(null);
	const [detail, setDetail] = useState<AuditCheck | "all" | null>(null);
	const [editing, setEditing] = useState(false);
	const audit = project.websiteAudits?.find((item) => item.id === selectedAudit) ?? project.websiteAudits?.[0];
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
			setSelectedAudit(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "官网审计失败");
		} finally {
			setBusy(false);
		}
	}
	if (!project.website_url)
		return (
			<Page
				className="audit-page"
				breadcrumb={project.name}
				eyebrow="官网审计"
				title="该客户暂未填写官网"
				description="未填写官网仍可开展 AI 监测。"
			>
				<Alert showIcon type="info" title="暂无官网可供检查" description="补充官网后可运行审计。" />
				<Button permission="project.onboard" onClick={() => setEditing(true)}>
					补充官网
				</Button>
				{audit && (
					<>
						<p>此前官网的审计记录</p>
						<Select
							aria-label="历史官网审计"
							value={audit.id}
							onChange={setSelectedAudit}
							options={project.websiteAudits.map((item) => ({ value: item.id, label: date(item.checked_at) }))}
						/>
						<Button variant="secondary" onClick={() => setDetail("all")}>
							打开历史官网证据
						</Button>
						<AuditEvidenceDrawer audit={audit} detail={detail} onClose={() => setDetail(null)} />
					</>
				)}
				{editing && <ProjectProfileEditor project={project} refresh={refresh} onClose={() => setEditing(false)} />}
			</Page>
		);
	if (!audit)
		return (
			<Page
				className="audit-page"
				breadcrumb={project.name}
				eyebrow="官网审计"
				title="官网 AI 可读性检查"
				description="检查 AI 能否稳定读取官网并引用页面事实。"
				extra={
					<Button permission="audit.run" busy={busy} icon={<IconShieldCheck size={17} />} onClick={run}>
						开始审计
					</Button>
				}
			>
				{error && <Alert type="error" showIcon title={error} />}
				{busy && <Alert type="info" showIcon title="正在检查官网并保存截图，审计不产生模型费用。" />}
				<Empty title="还没有官网审计证据" detail="审计记录包含官网页面、抓取规则、网站地图和截图。" />
			</Page>
		);
	const passCount = audit.result.checks.filter((check) => check.status === "pass").length;
	const verdictLabel = verdictLabels[audit.result.verdict] ?? audit.result.verdict;
	return (
		<Page
			className="audit-page"
			breadcrumb={project.name}
			eyebrow="官网审计"
			title="官网 AI 可读性检查"
			description="检查 AI 能否稳定读取官网并引用页面事实。"
			extra={
				<Button permission="audit.run" busy={busy} icon={<IconShieldCheck size={17} />} onClick={run}>
					重新审计
				</Button>
			}
		>
			{error && <Alert type="error" showIcon title={error} />}
			{busy && <Alert type="info" showIcon title="正在检查官网、保存截图并生成报告，请稍候。" />}
			<div className="actions audit-toolbar">
				<Select
					aria-label="选择审计历史"
					value={audit.id}
					onChange={(value) => {
						setSelectedAudit(value);
						setDetail(null);
					}}
					options={project.websiteAudits.map((item) => ({
						value: item.id,
						label: `${date(item.checked_at)} · ${item.result.requestedUrl}`,
					}))}
				/>
				<Button variant="secondary" onClick={() => setDetail("all")}>
					查看全部审计证据
				</Button>
				{audit.result.evidence
					?.filter((item) => item.kind === "report" && item.objectKey)
					.map((item) => (
						<Button
							variant="secondary"
							key={item.id}
							href={artifactHref(item.objectKey!)}
							target="_blank"
							rel="noopener noreferrer"
						>
							下载{item.contentType === "application/pdf" ? " PDF" : " HTML"}审计报告
						</Button>
					))}
			</div>
			<div className="audit-hero">
				<Statistic
					title={<MetricLabel label="首页技术检查（非 AI 排名）" help={websiteScoreGuide} />}
					value={audit.result.score ?? "未评分"}
					suffix={audit.result.score === null ? undefined : "/ 100"}
				/>
				<div className="audit-hero-text">
					<p>{scoreDescription(audit.result)}</p>
					<Tag>{verdictLabel}</Tag>
					<p className="muted">
						最近审计：{date(audit.result.checkedAt)} · {audit.result.checks.length} 项检查{" "}
						<Button variant="link" onClick={() => setDetail("all")}>
							打开审计证据
						</Button>
						<IdChip value={audit.id} label="编号" />
					</p>
				</div>
			</div>
			{!audit.result.transport.https.ok &&
				(audit.result.transport.httpFallback.ok || audit.result.transport.browserFallback.ok) && (
					<Alert
						type="warning"
						showIcon
						message="HTTPS 校验失败。以下内容来自 HTTP 或浏览器方式读取，HTTPS 和机器人访问检查仍未通过。"
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
					{
						key: "sitemap",
						label: "XML Sitemap",
						children: `${audit.result.discovery.sitemap.urlCount} 个已解析页面 URL${audit.result.discovery.sitemap.limited ? "（有限扫描）" : ""}`,
					},
					{ key: "jsonld", label: "JSON-LD", children: `${audit.result.homepage.structuredDataTypes.length || 0} 类` },
				]}
			/>
			<Alert
				showIcon
				type="info"
				title="网站地图检查范围"
				description="本次检查区分导航菜单、HTML 网站地图和 XML Sitemap。未找到或读取失败，均不足以判断全站是否存在网站地图。"
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
							<strong>{websiteCheckLanguage[check.id]?.label ?? check.label}</strong>
							<p>{check.detail}</p>
							<p className="muted">{websiteCheckLanguage[check.id]?.meaning}</p>
							<Button variant="link" onClick={() => setDetail(check)}>
								查看详情
							</Button>
						</div>
					</article>
				))}
			</div>
			<AuditEvidenceDrawer audit={audit} detail={detail} onClose={() => setDetail(null)} />
		</Page>
	);
}

const artifactHref = (key: string) => `/artifacts/${key.split("/").map(encodeURIComponent).join("/")}`;
function CheckInterpretation({ check }: { check: AuditCheck }) {
	return (
		<>
			<p>{websiteCheckLanguage[check.id]?.meaning}</p>
			<p>建议负责人：{websiteCheckLanguage[check.id]?.owner ?? "网站负责人"}</p>
			<p>
				本项权重：{check.weight}；
				{check.status === "skip"
					? "不参与计分"
					: check.status === "pass"
						? "获得全部权重"
						: check.status === "warning"
							? "获得一半权重"
							: "未获得权重"}
				。
			</p>
		</>
	);
}
const checkRecommendation = (check: AuditCheck) =>
	check.status === "pass"
		? "本项已通过，保持现状，无需重复安排整改。"
		: (check.recommendation ?? "旧记录未提供逐项建议，请结合原始证据核对。");
export function AuditEvidenceDrawer({
	audit,
	detail,
	onClose,
}: {
	audit: WebsiteAuditRecord;
	detail: AuditCheck | "all" | null;
	onClose(): void;
}) {
	const check = detail && detail !== "all" ? detail : null;
	const evidence = audit.result.evidence ?? [];
	const sources = check?.evidenceIds
		? evidence.filter((item) => check.evidenceIds!.includes(item.id))
		: evidence.filter((item) => item.kind !== "screenshot" && item.kind !== "report");
	const screenshot = evidence.find((item) => item.kind === "screenshot");
	return (
		<Drawer
			open={Boolean(detail)}
			onClose={onClose}
			title={check ? `${check.label} · 证据与整改` : "审计证据详情"}
			size="min(880px, 100vw)"
		>
			<div className="audit-evidence-detail">
				<Descriptions
					size="small"
					column={1}
					items={[
						{ key: "client", label: "客户", children: audit.result.customer?.name ?? "历史记录未冻结客户信息" },
						{ key: "url", label: "本次请求", children: audit.result.requestedUrl },
						{ key: "time", label: "取证时间", children: date(audit.result.checkedAt) },
						{ key: "id", label: "审计编号", children: <IdChip value={audit.id} /> },
					]}
				/>
				{check && (
					<>
						<CheckInterpretation check={check} />
						<h3>观察事实</h3>
						<p>{check.detail}</p>
						<h3>问题定位</h3>
						<p>{check.selector ?? "旧记录未保存定位信息，请新建审计。"}</p>
						<h3>整改建议</h3>
						<p>{checkRecommendation(check)}</p>
						<h3>验收办法</h3>
						<p>{check.verification ?? "修复后重新审计，保留新旧两份结果。"}</p>
					</>
				)}
				{screenshot?.objectKey ? (
					<>
						<h3>本次首页截图</h3>
						<p>
							{audit.result.screenshotMode === "restricted_browser_render"
								? "已保存 HTML 的受控浏览器渲染，API、表单与实时连接禁用"
								: "已保存 HTML 的静态渲染，脚本禁用"}
							；可点击放大。源码、robots 和 XML 中的问题请查看源证据。
						</p>
						<Image width="100%" src={artifactHref(screenshot.objectKey)} alt="本次官网审计的取证截图" />
					</>
				) : (
					<Alert showIcon type="warning" title={screenshot?.error ?? "这份审计未保存截图，可重新审计。"} />
				)}
				{(!check || check.id === "A4") && (
					<>
						<h3>Sitemap 请求与解析记录</h3>
						{audit.result.discovery.sitemap.documents?.map((doc) => (
							<article key={doc.url}>
								<strong>{doc.url}</strong>
								<p>
									类型 {sitemapKinds[doc.kind] ?? doc.kind} · HTTP {doc.status ?? "未取得响应"} · {doc.urlCount} 个页面
									URL
								</p>
								{doc.error && <p>{doc.error}</p>}
							</article>
						))}
						<p>
							按语义标签识别的导航链接：{audit.result.discovery.sitemap.navigationLinkCount ?? "历史未记录"}
							（不代表菜单总量）；HTML 地图：
							{audit.result.discovery.sitemap.htmlSitemapUrls?.join("、") || "未发现或旧记录未记录"}
						</p>
						{Boolean(audit.result.discovery.sitemap.urls?.length) && (
							<pre>{audit.result.discovery.sitemap.urls?.join("\n")}</pre>
						)}
					</>
				)}
				<h3>关联原始证据</h3>
				{sources.length ? (
					sources.map((item) => (
						<article key={item.id}>
							<strong>
								{sourceKinds[item.kind] ?? item.kind} · {item.id}
							</strong>
							<p>{item.url}</p>
							<p>
								HTTP {item.status ?? "不适用"} ·{" "}
								{item.contentHash ? <IdChip value={item.contentHash} label="SHA-256" length={12} /> : "没有原始正文"}
							</p>
							{item.error && <Alert type="warning" showIcon title={item.error} />}
							{item.objectKey && (
								<Button
									variant="secondary"
									href={artifactHref(item.objectKey)}
									target="_blank"
									rel="noopener noreferrer"
								>
									打开 / 下载完整源文件
								</Button>
							)}
							{item.excerpt && <pre>{item.excerpt}</pre>}
						</article>
					))
				) : (
					<p>历史记录仅有检查摘要，无原始源文件。</p>
				)}
				<h3>范围与局限</h3>
				{audit.result.limitations?.map((item) => (
					<p key={item}>{item}</p>
				))}
			</div>
		</Drawer>
	);
}
