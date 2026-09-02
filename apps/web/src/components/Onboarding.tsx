import { IconCheck, IconClipboardCheck, IconSearch, IconWorldSearch } from "@tabler/icons-react";
import { Alert, Steps } from "antd";
import { useEffect, useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { Competitor, Project, Prompt } from "../types";
import { type EditableField, EditableList } from "./EditableList";
import { Page } from "./Page";

const STEPS = [{ title: "抓取官网" }, { title: "人工确认" }, { title: "建立基线" }];

const COMPETITOR_FIELDS: EditableField<Competitor>[] = [
	{ key: "name", label: "竞品名称", width: 150 },
	{ key: "domain", label: "竞品域名", placeholder: "example.com", width: 190 },
];

const PROMPT_FIELDS: EditableField<Prompt>[] = [
	{ key: "question", label: "监测问题", width: 280 },
	{ key: "intent", label: "意图", width: 110 },
	{ key: "topic", label: "主题", width: 120 },
	{ key: "persona", label: "购买者角色", width: 130 },
];

export function Onboarding({ project, refresh }: { project: Project; refresh(): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [manualReview, setManualReview] = useState(false);
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState<Competitor[]>(project.competitors ?? []);
	const [prompts, setPrompts] = useState<Prompt[]>(project.prompts ?? []);
	useEffect(() => {
		setAliases(project.aliases ?? []);
		setCompetitors(project.competitors ?? []);
		setPrompts(project.prompts ?? []);
	}, [project]);
	async function analyze() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/analyze`);
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "分析失败");
		} finally {
			setBusy(false);
		}
	}
	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/confirm`, { aliases, competitors, prompts });
			await refresh();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "确认失败");
		} finally {
			setBusy(false);
		}
	}
	if (project.status === "draft" && !manualReview)
		return (
			<Page
				className="onboarding"
				breadcrumb={project.name}
				eyebrow="客户建档"
				title="读取客户的真实官网"
				description="建档分三步：抓取官网 → 人工确认监测范围 → 建立基线。"
			>
				<Steps size="small" current={0} items={STEPS} className="onboarding-steps" />
				<div className="action-panel">
					<IconWorldSearch size={34} />
					<h2>读取客户的真实官网</h2>
					<p>
						系统会抓取 Sitemap 及最多 100 个同域页面，再由 HRouter GPT
						生成客户画像、竞品候选和购买问题，并合并当前机构同业知识库。此过程需要已配置的 Agent 模型与 API Key。
					</p>
					{error && <Alert type="error" showIcon message={error} />}
					<div className="actions">
						<Button permission="project.onboard" busy={busy} icon={<IconSearch size={17} />} onClick={analyze}>
							{busy ? "正在抓取和分析" : "开始官网分析"}
						</Button>
						<Button
							permission="project.onboard"
							variant="secondary"
							icon={<IconClipboardCheck size={17} />}
							onClick={() => setManualReview(true)}
						>
							手工配置监测范围
						</Button>
					</div>
				</div>
			</Page>
		);
	return (
		<Page
			className="onboarding"
			breadcrumb={project.name}
			eyebrow="客户建档"
			title="审核监测范围"
			description={
				manualReview
					? "直接填写真实品牌别名、竞品和购买问题。确认前不会创建采集任务。"
					: "删除不真实的竞品，修改问题后再确认。确认前不会创建采集任务。"
			}
			extra={
				<Button permission="project.onboard" busy={busy} icon={<IconCheck size={17} />} onClick={confirm}>
					确认并启用项目
				</Button>
			}
		>
			<Steps size="small" current={1} items={STEPS} className="onboarding-steps" />
			{error && <Alert type="error" showIcon message={error} />}
			<EditableList joined title="品牌别名" items={aliases} onChange={setAliases} placeholder="多个别名用逗号分隔" />
			<EditableList
				title="竞品候选"
				items={competitors}
				onChange={setCompetitors}
				fields={COMPETITOR_FIELDS}
				makeNew={() => ({ name: "", domain: "", aliases: [] })}
				empty={<p className="muted">当前没有竞品候选，可以添加后再确认。</p>}
			/>
			<EditableList
				title="购买问题"
				items={prompts}
				onChange={setPrompts}
				fields={PROMPT_FIELDS}
				makeNew={() => ({ question: "", intent: "购买决策", topic: "", persona: "", tags: [] })}
				indexed
			/>
		</Page>
	);
}
