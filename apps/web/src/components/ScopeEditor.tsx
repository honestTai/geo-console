import { IconCheck } from "@tabler/icons-react";
import { Alert, App, Modal } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { Competitor, Project, Prompt } from "../types";
import { buildScopeBundle, parseScopeBundle, SCOPE_BUNDLE_KIND } from "../ui/scope-bundle";
import { downloadJson, TransferButtons, transferFileName } from "../ui/transfer";
import { type EditableField, EditableList } from "./EditableList";

const COMPETITOR_FIELDS: EditableField<Competitor>[] = [
	{ key: "name", label: "名称", width: 140 },
	{ key: "domain", label: "域名", placeholder: "example.com", width: 180 },
	{ key: "aliases", label: "别名", commaList: true, placeholder: "多个别名用逗号分隔", width: 180 },
];

const PROMPT_FIELDS: EditableField<Prompt>[] = [
	{ key: "question", label: "监测问题", width: 260 },
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
	const { message } = App.useApp();
	const [aliases, setAliases] = useState(project.aliases ?? [project.name]);
	const [competitors, setCompetitors] = useState<Competitor[]>(project.competitors ?? []);
	const [prompts, setPrompts] = useState<Prompt[]>(project.prompts ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [imported, setImported] = useState<string | null>(null);
	async function save() {
		setBusy(true);
		setError(null);
		try {
			const result = await post<{ libraryUnlinked?: number; promptsKept?: number }>(
				`/api/projects/${project.id}/confirm`,
				{ aliases, competitors, prompts },
			);
			if (result.libraryUnlinked)
				message.info(`${result.libraryUnlinked} 个问题引用了其他机构或已归档的知识库记录，已去掉引用后保存`);
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
			width={920}
			onCancel={onClose}
			title={
				<div className="scope-editor-head">
					<div>
						<span className="eyebrow">监测范围版本</span>
						<h2>编辑当前监测范围</h2>
					</div>
					<div className="actions">
						<TransferButtons
							exportLabel="导出范围"
							importLabel="导入范围"
							expectedKind={SCOPE_BUNDLE_KIND}
							kindLabel="监测范围"
							importPermission="project.onboard"
							onExport={() =>
								downloadJson(
									transferFileName(`geo-监测范围-${project.name}`),
									buildScopeBundle(project, { aliases, competitors, prompts }),
								)
							}
							onImport={async (bundle) => {
								const scope = parseScopeBundle(bundle);
								setAliases(scope.aliases.length ? scope.aliases : aliases);
								setCompetitors(scope.competitors);
								setPrompts(scope.prompts);
								const source =
									bundle.project && typeof bundle.project === "object"
										? (bundle.project as { name?: unknown }).name
										: null;
								setImported(
									`已载入${typeof source === "string" && source ? `「${source}」的` : ""}范围：${scope.competitors.length} 个竞品、${scope.prompts.length} 个问题；核对后点“保存新范围版本”才会生效。`,
								);
								return "范围已载入编辑器，尚未保存";
							}}
						/>
					</div>
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
			<p className="muted">
				保存后只影响新基线；历史批次、回答证据和报告继续保留原问题与竞品。没改动的问题和竞品沿用原
				ID，同条件趋势不会中断。
			</p>
			{error && <Alert type="error" showIcon title={error} />}
			{imported && <Alert type="info" showIcon closable title={imported} onClose={() => setImported(null)} />}
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
