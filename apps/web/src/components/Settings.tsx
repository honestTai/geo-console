import { IconKey, IconLoader2, IconRefresh } from "@tabler/icons-react";
import { App, AutoComplete, Descriptions, Form, Input, Select, Space, Switch, Tabs, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import {
	type AgentThinkingLevel,
	type ProviderDraft,
	type ProviderId,
	type ProviderSetting,
	providerLogoPaths,
	providerShortLabel,
	thinkingLevelOptions,
} from "../types";
import { SectionTitle } from "../ui/primitives";
import { downloadJson, TransferButtons, transferFileName } from "../ui/transfer";
import { Page } from "./Page";
import "./Settings.css";

type ProviderModelList = { models: string[]; source: "provider" | "unavailable"; message: string | null };
type SettingsImportResult = {
	hrouter: { applied: boolean; note: string | null };
	providers: Array<{ providerId: string; enabled: boolean; note: string | null }>;
};

/** 从平台读取模型列表并整理成下拉选项；当前值不在列表里时追加一项，避免下拉把已保存的模型“吞掉”。 */
function useProviderModels(provider: ProviderSetting, currentModel: string) {
	const [modelList, setModelList] = useState<ProviderModelList | null>(null);
	const [modelsLoading, setModelsLoading] = useState(false);
	const loadProviderModels = useCallback(async () => {
		setModelsLoading(true);
		try {
			setModelList(await api<ProviderModelList>(`/api/settings/providers/${provider.providerId}/models`));
		} catch (reason) {
			setModelList({
				models: [],
				source: "unavailable",
				message: reason instanceof Error ? reason.message : "模型列表加载失败",
			});
		} finally {
			setModelsLoading(false);
		}
	}, [provider.providerId]);
	useEffect(() => {
		setModelList(null);
		if (provider.configured) void loadProviderModels();
	}, [provider.configured, loadProviderModels]);
	const models = modelList?.models ?? [];
	const modelOptions = [
		...models.map((id) => ({ value: id, label: id })),
		...(currentModel && !models.includes(currentModel) ? [{ value: currentModel, label: `${currentModel}（当前值）` }] : []),
	];
	const modelHelp = modelsLoading
		? "正在从平台读取模型列表…"
		: modelList?.source === "provider"
			? `已从平台读取 ${models.length} 个模型；也可以直接输入模型 ID`
			: (modelList?.message ?? "保存 API Key 后自动读取平台模型列表；也可以直接输入模型 ID");
	return { modelsLoading, loadProviderModels, modelOptions, modelHelp };
}

function providerTestStatus(provider: ProviderSetting): string {
	const label =
		provider.lastTestStatus === "ok" ? "连接正常" : provider.lastTestStatus === "failed" ? "连接失败" : "未测试";
	return provider.lastTestMessage && provider.lastTestMessage !== label ? `${label} · ${provider.lastTestMessage}` : label;
}

function ProviderContract({ provider }: { provider: ProviderSetting }) {
	return (
		<Descriptions
			className="provider-contract"
			size="small"
			colon={false}
			column={{ xs: 1, sm: 2, md: 4 }}
			items={[
				{ key: "protocol", label: "协议", children: <code>{provider.protocol}</code> },
				{ key: "searchTool", label: "搜索工具", children: provider.searchToolVersion },
				{ key: "apiKey", label: "密钥", children: provider.configured ? "已配置" : "未配置" },
				...(provider.secondaryConfigured !== null
					? [
							{
								key: "secondaryKey",
								label: "混元密钥",
								children: provider.secondaryConfigured ? "已配置" : "未配置",
							},
						]
					: []),
			]}
		/>
	);
}

export function ProviderPanel({
	provider,
	draft,
	busy,
	update,
	runAction,
}: {
	provider: ProviderSetting;
	draft: ProviderDraft;
	busy: string | null;
	update(values: ProviderDraft): void;
	runAction(name: string, run: () => Promise<unknown>): Promise<void>;
}) {
	const currentModel = String(draft.model ?? "");
	const { modelsLoading, loadProviderModels, modelOptions, modelHelp } = useProviderModels(provider, currentModel);
	return (
		<article id="active-provider-panel" className="provider-panel">
			<header>
				<div className="provider-panel-title">
					<span className="platform-logo">
						<img src={providerLogoPaths[provider.providerId]} alt="" aria-hidden="true" />
					</span>
					<div>
						<h3>{provider.label}</h3>
						<p>{provider.disclosure}</p>
					</div>
				</div>
				<Space size={8}>
					<Switch checked={Boolean(draft.enabled)} onChange={(checked) => update({ enabled: checked })} />
					<span>启用</span>
				</Space>
			</header>
			<ProviderContract provider={provider} />
			<Form layout="vertical" className="provider-form">
				<div className="settings-grid">
					<Form.Item label="模型" help={modelHelp}>
						<AutoComplete
							value={currentModel}
							onChange={(value) => update({ model: String(value ?? "").trim() })}
							options={modelOptions}
							filterOption={(input, option) =>
								String(option?.value ?? "")
									.toLowerCase()
									.includes(input.toLowerCase())
							}
							placeholder="选择或输入模型 ID"
							allowClear
							notFoundContent={modelsLoading ? "正在读取模型…" : null}
						/>
					</Form.Item>
					<Form.Item label="API 地址">
						<Input
							value={String(draft.endpoint ?? "")}
							onChange={(event) => update({ endpoint: event.target.value })}
						/>
					</Form.Item>
					{provider.secondaryEndpoint !== null ? (
						<Form.Item label="混元合成地址">
							<Input
								value={String(draft.secondaryEndpoint ?? "")}
								onChange={(event) => update({ secondaryEndpoint: event.target.value })}
							/>
						</Form.Item>
					) : null}
					<Form.Item label="API Key">
						<Input.Password
							value={draft.apiKey ?? ""}
							onChange={(event) => update({ apiKey: event.target.value })}
							placeholder={provider.configured ? "留空保持现有密钥" : "必填"}
						/>
					</Form.Item>
					{provider.secondaryConfigured !== null ? (
						<Form.Item label="混元 API Key">
							<Input.Password
								value={draft.secondaryApiKey ?? ""}
								onChange={(event) => update({ secondaryApiKey: event.target.value })}
								placeholder={provider.secondaryConfigured ? "留空保持现有密钥" : "必填"}
							/>
						</Form.Item>
					) : null}
				</div>
			</Form>
			<footer>
				<span className={`status ${provider.lastTestStatus ?? "idle"}`}>{providerTestStatus(provider)}</span>
				<div className="actions">
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={modelsLoading}
						disabled={!provider.configured}
						onClick={() => void loadProviderModels()}
					>
						刷新模型列表
					</Button>
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={busy === `${provider.providerId}-test`}
						onClick={() =>
							runAction(`${provider.providerId}-test`, () =>
								post(`/api/settings/providers/${provider.providerId}/test`),
							)
						}
					>
						测试连接
					</Button>
					<Button
						permission="settings.manage"
						busy={busy === `${provider.providerId}-save`}
						onClick={() =>
							runAction(`${provider.providerId}-save`, () =>
								put(`/api/settings/providers/${provider.providerId}`, {
									enabled: Boolean(draft.enabled),
									model: draft.model,
									endpoint: draft.endpoint,
									secondaryEndpoint: draft.secondaryEndpoint,
									...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
									...(draft.secondaryApiKey ? { secondaryApiKey: draft.secondaryApiKey } : {}),
									options: {},
								}),
							)
						}
					>
						保存平台
					</Button>
				</div>
			</footer>
		</article>
	);
}

type AnalysisConfig = {
	baseUrl: string;
	model: string;
	thinkingLevel: AgentThinkingLevel;
	configured: boolean;
};

type HRouterModel = { id: string; ownedBy?: string | null };

export function Settings() {
	const { message } = App.useApp();
	const [providers, setProviders] = useState<ProviderSetting[]>([]);
	const [activeProviderId, setActiveProviderId] = useState<ProviderId>("deepseek_api");
	const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
	const [analysis, setAnalysis] = useState<AnalysisConfig>({
		baseUrl: "https://hrouter.net/v1",
		model: "",
		thinkingLevel: "low",
		configured: false,
	});
	const [analysisKey, setAnalysisKey] = useState("");
	const [models, setModels] = useState<HRouterModel[]>([]);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const loadModels = useCallback(async () => {
		setBusy("hrouter-models");
		try {
			const result = await api<{ models: HRouterModel[]; message: string | null }>("/api/settings/hrouter/models");
			setModels(result.models);
			setModelsError(
				result.models.length
					? null
					: (result.message ?? "HRouter 没有返回可用的 GPT 模型，可在下拉框中直接输入模型 ID"),
			);
		} catch (reason) {
			setModels([]);
			setModelsError(reason instanceof Error ? reason.message : "模型列表加载失败，可在下拉框中直接输入模型 ID");
		} finally {
			setBusy((current) => (current === "hrouter-models" ? null : current));
		}
	}, []);
	const load = useCallback(async () => {
		const value = await api<{
			providers: ProviderSetting[];
			analysis: { baseUrl: string; model: string | null; thinkingLevel?: AgentThinkingLevel; configured: boolean };
		}>("/api/settings");
		setProviders(value.providers);
		setActiveProviderId((current) =>
			value.providers.some((provider) => provider.providerId === current)
				? current
				: (value.providers[0]?.providerId ?? "deepseek_api"),
		);
		setDrafts(Object.fromEntries(value.providers.map((provider) => [provider.providerId, { ...provider }])));
		setAnalysis({
			baseUrl: value.analysis.baseUrl,
			model: value.analysis.model ?? "",
			thinkingLevel: value.analysis.thinkingLevel ?? "low",
			configured: value.analysis.configured,
		});
		return value.analysis.configured;
	}, []);
	useEffect(() => {
		void load()
			.then((configured) => {
				if (configured) return loadModels();
			})
			.catch((reason) => message.error(reason instanceof Error ? reason.message : "设置加载失败"));
	}, [load, loadModels, message]);
	async function action(name: string, run: () => Promise<unknown>, successText = "操作成功") {
		setBusy(name);
		try {
			await run();
			message.success(successText);
			await load();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "操作失败");
		} finally {
			setBusy(null);
		}
	}
	function updateProvider(id: ProviderId, values: ProviderDraft) {
		setDrafts((current) => ({ ...current, [id]: { ...current[id], ...values } }));
	}
	const activeProvider = providers.find((provider) => provider.providerId === activeProviderId) ?? providers[0];
	const activeDraft = activeProvider ? (drafts[activeProvider.providerId] ?? activeProvider) : null;
	const modelOptions = [
		...models.map((item) => ({
			value: item.id,
			label: (
				<span className="hrouter-model-option">
					<span>{item.id}</span>
					{item.ownedBy && <small>{item.ownedBy}</small>}
				</span>
			),
			text: item.id,
		})),
		...(analysis.model && !models.some((item) => item.id === analysis.model)
			? [{ value: analysis.model, label: `${analysis.model}（当前值）`, text: analysis.model }]
			: []),
	];
	const modelHelp =
		modelsError ??
		(models.length
			? `已从 HRouter 读取 ${models.length} 个 GPT 模型；也可以直接输入模型 ID`
			: analysis.configured
				? "点击“刷新模型列表”读取可用模型，或直接输入模型 ID"
				: "先保存 API Key，系统会自动读取可用的 GPT 模型");
	return (
		<Page
			eyebrow="平台设置"
			title="模型与联网平台"
			description="HRouter Agent 模型与五个联网平台的 API 配置；密钥加密保存。"
			extra={
				<div className="actions">
					<TransferButtons
						expectedKind="geo-settings"
						kindLabel="平台设置"
						importPermission="settings.manage"
						onExport={async () => {
							downloadJson(transferFileName("geo-平台设置"), await api("/api/settings/export"));
						}}
						onImport={async (bundle) => {
							const result = await post<SettingsImportResult>("/api/settings/import", bundle);
							await load();
							const missingKeys = result.providers.filter((item) => item.note).length;
							return [
								`已导入${result.hrouter.applied ? " HRouter 设置与" : ""} ${result.providers.length} 个平台的配置`,
								missingKeys ? `${missingKeys} 个平台缺少 API Key，已按停用导入` : "",
								result.hrouter.note ?? "",
							]
								.filter(Boolean)
								.join("；");
						}}
					/>
					<Button variant="secondary" icon={<IconRefresh size={17} />} onClick={() => void load()}>
						刷新状态
					</Button>
				</div>
			}
		>
			<SectionTitle
				title={
					<>
						<IconKey size={16} />
						HRouter Agent 模型
					</>
				}
				description={`报告、诊断、优化文章与 AI 工作台都通过受限领域工具调用下面选定的 GPT。密钥：${analysis.configured ? "已配置" : "未配置"}`}
			/>
			<Form layout="vertical" className="settings-form hrouter-form">
				<div className="settings-grid">
					<Form.Item label="API 地址">
						<Input
							value={analysis.baseUrl}
							onChange={(event) => setAnalysis({ ...analysis, baseUrl: event.target.value })}
						/>
					</Form.Item>
					<Form.Item label="API Key">
						<Input.Password
							value={analysisKey}
							onChange={(event) => setAnalysisKey(event.target.value)}
							placeholder={analysis.configured ? "留空保持现有密钥" : "输入 HRouter API Key"}
						/>
					</Form.Item>
					<Form.Item label="GPT 模型" help={modelHelp}>
						<AutoComplete
							value={analysis.model}
							onChange={(value) => setAnalysis({ ...analysis, model: String(value ?? "").trim() })}
							options={modelOptions}
							filterOption={(input, option) =>
								String(option?.text ?? "")
									.toLowerCase()
									.includes(input.toLowerCase())
							}
							placeholder={models.length ? "选择或输入 GPT 模型" : "输入 GPT 模型 ID，如 gpt-5.5"}
							notFoundContent={busy === "hrouter-models" ? "正在读取模型…" : null}
							allowClear
						/>
					</Form.Item>
					<Form.Item
						label={
							<Tooltip title="仅 HRouter Agent 使用：越高越慢越贵，但证据比对更完整。AI 工作台可按会话覆盖。">
								<span>思考强度</span>
							</Tooltip>
						}
						help={thinkingLevelOptions.find((item) => item.value === analysis.thinkingLevel)?.hint}
					>
						<Select
							value={analysis.thinkingLevel}
							onChange={(value) => setAnalysis({ ...analysis, thinkingLevel: value })}
							options={thinkingLevelOptions.map((item) => ({ value: item.value, label: item.label }))}
						/>
					</Form.Item>
				</div>
				<div className="actions">
					<Button
						permission="settings.manage"
						busy={busy === "hrouter-save"}
						disabled={!analysisKey && !analysis.configured}
						onClick={() =>
							action(
								"hrouter-save",
								async () => {
									await put("/api/settings/hrouter", {
										baseUrl: analysis.baseUrl,
										model: analysis.model || null,
										thinkingLevel: analysis.thinkingLevel,
										...(analysisKey ? { apiKey: analysisKey } : {}),
									});
									setAnalysisKey("");
									await loadModels();
								},
								analysis.model ? "模型配置已保存" : "密钥已保存，请从下拉框选择 GPT 模型后再次保存",
							)
						}
					>
						保存模型配置
					</Button>
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={busy === "hrouter-models"}
						disabled={!analysis.configured}
						onClick={() => void loadModels()}
					>
						刷新模型列表
					</Button>
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={busy === "hrouter-test"}
						disabled={!analysis.configured}
						onClick={() =>
							action(
								"hrouter-test",
								async () => {
									const result = await post<{ selectedModelAvailable: boolean }>("/api/settings/hrouter/test");
									if (!result.selectedModelAvailable) throw new Error("连接正常，但当前模型不在可用列表中");
								},
								"连接正常，模型可用",
							)
						}
					>
						测试连接
					</Button>
				</div>
			</Form>
			<SectionTitle
				title="联网监测平台"
				description="每个平台使用冻结的协议契约采集；启用后才会进入批次。"
				count={`${providers.filter((provider) => provider.enabled).length}/${providers.length} 已启用`}
			/>
			<div className="provider-settings">
				<Tabs
					activeKey={activeProvider?.providerId}
					onChange={(key) => setActiveProviderId(key as ProviderId)}
					items={providers.map((provider) => ({
						key: provider.providerId,
						label: (
							<span className="provider-tab-item">
								<img src={providerLogoPaths[provider.providerId]} alt="" aria-hidden="true" />
								<span>
									<strong>{providerShortLabel(provider.providerId)}</strong>
									<small>{provider.enabled ? "已启用" : provider.configured ? "已配置" : "未配置"}</small>
								</span>
								<i className={provider.lastTestStatus ?? "idle"} aria-hidden="true" />
							</span>
						),
					}))}
				/>
				{activeProvider && activeDraft ? (
					<ProviderPanel
						provider={activeProvider}
						draft={activeDraft}
						busy={busy}
						update={(values) => updateProvider(activeProvider.providerId, values)}
						runAction={action}
					/>
				) : (
					<div className="chart-loading">
						<IconLoader2 className="spin" size={17} />
						<span>正在加载平台配置</span>
					</div>
				)}
			</div>
		</Page>
	);
}
