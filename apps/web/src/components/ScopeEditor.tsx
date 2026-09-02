import { IconCheck } from "@tabler/icons-react";
import { Alert, Modal } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { Competitor, Project, Prompt } from "../types";
import { type EditableField, EditableList } from "./EditableList";

const COMPETITOR_FIELDS: EditableField<Competitor>[] = [
	{ key: "name", label: "名称", width: 140 },
	{ key: "domain", label: "域名", placeholder: "example.com", width: 180 },
	{ key: "aliases", label: "别名", commaList: true, placeholder: "多个别名用逗号分隔", width: 180 },
];

const PROMPT_FIELDS: EditableField<Prompt>[] = [
	{ key: "question", label: "真实用户问题", width: 260 },
	{ key: "intent", label: "意图", width: 110 },
	{ key: "tags", label: "标签", commaList: true, width: 120 },
	{ key: "topic", label: "主题", width: 110 },
	{ key: "persona", label: "购买者角色", width: 120 },
];

export function ScopeEditor({
	project,
	onClose,
	refresh,
}: {
	project: Project;
	onClose(): void;
	refresh(): Promise<void>;
}) {
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState<Competitor[]>(project.competitors ?? []);
	const [prompts, setPrompts] = useState<Prompt[]>(project.prompts ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function save() {
		setBusy(true);
		setError(null);
		try {
			await post(`/api/projects/${project.id}/confirm`, { aliases, competitors, prompts });
			await refresh();
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "保存失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Modal
			open
			width={820}
			onCancel={onClose}
			title={
				<div>
					<span className="eyebrow">监测范围版本</span>
					<h2>编辑当前监测范围</h2>
				</div>
			}
			footer={
				<>
					<Button variant="secondary" onClick={onClose}>
						取消
					</Button>
					<Button permission="project.onboard" busy={busy} icon={<IconCheck size={17} />} onClick={save}>
						保存新范围版本
					</Button>
				</>
			}
		>
			<p className="muted">保存后只影响新基线；历史批次、回答证据和报告继续保留原问题与竞品。</p>
			{error && <Alert type="error" showIcon message={error} />}
			<EditableList joined title="品牌别名" items={aliases} onChange={setAliases} placeholder="多个别名用逗号分隔" />
			<EditableList
				title="竞品"
				description="域名用于识别引用来源，别名用于回答中的实体匹配。"
				items={competitors}
				onChange={setCompetitors}
				fields={COMPETITOR_FIELDS}
				makeNew={() => ({ name: "", domain: "", aliases: [] })}
				addLabel="添加竞品"
				addPermission="project.onboard"
			/>
			<EditableList
				title="购买问题"
				description="同条件趋势只比较问题、平台、重复次数和版本完全一致的批次。"
				items={prompts}
				onChange={setPrompts}
				fields={PROMPT_FIELDS}
				makeNew={() => ({ question: "", intent: "购买决策", topic: "", persona: "", tags: [] })}
				addLabel="添加问题"
				indexed
			/>
		</Modal>
	);
}
