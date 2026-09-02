import { IconKey, IconLoader2, IconRefresh } from "@tabler/icons-react";
import { App, Descriptions, Form, Input, Select, Space, Switch, Tabs, Tooltip } from "antd";
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
import { Page } from "./Page";
import "./Settings.css";

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
			<Descriptions
				className="provider-contract"
				size="small"
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
			<Form layout="vertical" className="provider-form">
				<div className="settings-grid">
					<Form.Item label="模型">
						<Input value={String(draft.model ?? "")} onChange={(event) => update({ model: event.target.value })} />
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
				<span className={`status ${provider.lastTestStatus ?? "idle"}`}>
					{provider.lastTestStatus === "ok" ? "连接正常" : provider.lastTestStatus === "failed" ? "连接失败" : "未测试"}
					{provider.lastTestMessage ? ` · ${provider.lastTestMessage}` : ""}
				</span>
				<div className="actions">
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
	const [models, setModels] = useState<Array<{ id: string }>>([]);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const loadModels = useCallback(async () => {
		setBusy("hrouter-models");
		try {
			const result = await api<{ models: Array<{ id: string }> }>("/api/settings/hrouter/models");
			setModels(result.models);
			setModelsError(result.models.length ? null : "HRouter 没有返回可用的 GPT 模型，可手动填写");
		} catch (reason) {
			setModels([]);
			setModelsError(reason instanceof Error ? reason.message : "模型列表加载失败，可手动填写");
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
		...models.map((item) => ({ value: item.id, label: item.id })),
		...(analysis.model && !models.some((item) => item.id === analysis.model)
			? [{ value: analysis.model, label: `${analysis.model}（当前值）` }]
			: []),
	];
	return (
		<Page
			eyebrow="平台设置"
			title="模型与联网平台"
			description="内置 Agent 使用 HRouter 上的 GPT 模型；五个联网平台使用云端 API 采集真实回答。密钥以主密钥信封加密保存。"
			extra={
				<Button variant="secondary" icon={<IconRefresh size={17} />} onClick={() => void load()}>
					刷新状态
				</Button>
			}
		>
			<SectionTitle
				title={
					<>
						<IconKey size={16} />
						内置 Agent 模型
					</>
				}
				description={`Pi Agent 与报告 Agent 通过受限领域工具调用下面选定的 GPT。密钥：${analysis.configured ? "已配置" : "未配置"}`}
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
					<Form.Item
						label="GPT 模型"
						help={modelsError ?? (models.length ? `已从 HRouter 读取 ${models.length} 个 GPT 模型` : undefined)}
					>
						{models.length ? (
							<Select
								showSearch
								value={analysis.model || undefined}
								onChange={(value) => setAnalysis({ ...analysis, model: value })}
								options={modelOptions}
								placeholder="选择模型"
								loading={busy === "hrouter-models"}
							/>
						) : (
							<Input
								value={analysis.model}
								onChange={(event) => setAnalysis({ ...analysis, model: event.target.value })}
								placeholder="gpt-*"
							/>
						)}
					</Form.Item>
					<Form.Item
						label={
							<Tooltip title="仅内置 Agent 使用：越高越慢越贵，但证据比对更完整。AI 工作台可按会话覆盖。">
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
						disabled={!analysis.model}
						onClick={() =>
							action(
								"hrouter-save",
								() =>
									put("/api/settings/hrouter", {
										baseUrl: analysis.baseUrl,
										model: analysis.model,
										thinkingLevel: analysis.thinkingLevel,
										...(analysisKey ? { apiKey: analysisKey } : {}),
									}).then(() => setAnalysisKey("")),
								"模型配置已保存",
							)
						}
					>
						保存模型配置
					</Button>
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={busy === "hrouter-models"}
						onClick={() => void loadModels()}
					>
						刷新模型列表
					</Button>
					<Button
						permission="settings.manage"
						variant="secondary"
						busy={busy === "hrouter-test"}
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
