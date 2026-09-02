import { IconKey, IconLoader2, IconRefresh } from "@tabler/icons-react";
import { App, Descriptions, Form, Input, Select, Space, Switch, Tabs } from "antd";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import {
	type ProviderDraft,
	type ProviderId,
	type ProviderSetting,
	providerLogoPaths,
	providerShortLabel,
} from "../types";
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
		<article id="active-provider-panel">
			<header>
				<div>
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
				<Form.Item label="模型">
					<Input value={String(draft.model ?? "")} onChange={(event) => update({ model: event.target.value })} />
				</Form.Item>
				<Form.Item label="API 地址">
					<Input value={String(draft.endpoint ?? "")} onChange={(event) => update({ endpoint: event.target.value })} />
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
			</Form>
			<footer>
				<span className={`status ${provider.lastTestStatus ?? "idle"}`}>
					{provider.lastTestStatus ?? "未测试"} {provider.lastTestMessage ?? ""}
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

export function Settings() {
	const { message } = App.useApp();
	const [providers, setProviders] = useState<ProviderSetting[]>([]);
	const [activeProviderId, setActiveProviderId] = useState<ProviderId>("deepseek_api");
	const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
	const [analysis, setAnalysis] = useState({ baseUrl: "https://hrouter.net/v1", model: "", configured: false });
	const [analysisKey, setAnalysisKey] = useState("");
	const [models, setModels] = useState<Array<{ id: string }>>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const load = useCallback(async () => {
		const value = await api<{
			providers: ProviderSetting[];
			analysis: { baseUrl: string; model: string | null; configured: boolean };
		}>("/api/settings");
		setProviders(value.providers);
		setActiveProviderId((current) =>
			value.providers.some((provider) => provider.providerId === current)
				? current
				: (value.providers[0]?.providerId ?? "deepseek_api"),
		);
		setDrafts(Object.fromEntries(value.providers.map((provider) => [provider.providerId, { ...provider }])));
		setAnalysis({ ...value.analysis, model: value.analysis.model ?? "" });
	}, []);
	useEffect(() => {
		void load().catch((reason) => message.error(reason instanceof Error ? reason.message : "设置加载失败"));
	}, [load, message]);
	async function action(name: string, run: () => Promise<unknown>) {
		setBusy(name);
		try {
			await run();
			message.success("操作成功");
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
	return (
		<section>
			<div className="overview-head">
				<div>
					<span className="eyebrow">平台设置</span>
					<h2>平台与 GPT 设置</h2>
					<p className="muted">
						五个平台使用云端联网 API；HRouter GPT 与 Pi Agent 只生成待审批草稿。密钥以主密钥信封加密保存。
					</p>
				</div>
				<Button variant="secondary" icon={<IconRefresh size={17} />} onClick={() => void load()}>
					刷新状态
				</Button>
			</div>
			<div className="settings-band hrouter-settings">
				<div>
					<IconKey size={24} />
					<h3>HRouter GPT 分析模型</h3>
					<p>Pi SDK 通过受限领域工具调用管理员选定的 GPT。密钥：{analysis.configured ? "已配置" : "未配置"}</p>
				</div>
				<Form layout="vertical" className="key-form settings-form">
					<Form.Item label="API 地址">
						<Input
							value={analysis.baseUrl}
							onChange={(event) => setAnalysis({ ...analysis, baseUrl: event.target.value })}
						/>
					</Form.Item>
					<Form.Item label="GPT 模型">
						{models.length ? (
							<Select
								value={analysis.model || undefined}
								onChange={(value) => setAnalysis({ ...analysis, model: value })}
								options={models.map((item) => ({ value: item.id, label: item.id }))}
								placeholder="请选择"
							/>
						) : (
							<Input
								value={analysis.model}
								onChange={(event) => setAnalysis({ ...analysis, model: event.target.value })}
								placeholder="gpt-*"
							/>
						)}
					</Form.Item>
					<Form.Item label="API Key">
						<Input.Password
							value={analysisKey}
							onChange={(event) => setAnalysisKey(event.target.value)}
							placeholder={analysis.configured ? "留空保持现有密钥" : "输入 HRouter API Key"}
						/>
					</Form.Item>
					<div className="actions">
						<Button
							permission="settings.manage"
							busy={busy === "hrouter-save"}
							disabled={!analysis.model}
							onClick={() =>
								action("hrouter-save", () =>
									put("/api/settings/hrouter", {
										baseUrl: analysis.baseUrl,
										model: analysis.model,
										...(analysisKey ? { apiKey: analysisKey } : {}),
									}),
								)
							}
						>
							保存 GPT 配置
						</Button>
						<Button
							permission="settings.manage"
							variant="secondary"
							busy={busy === "hrouter-models"}
							onClick={() =>
								action("hrouter-models", async () => {
									const result = await api<{ models: Array<{ id: string }> }>("/api/settings/hrouter/models");
									setModels(result.models);
								})
							}
						>
							读取可用 GPT
						</Button>
						<Button
							permission="settings.manage"
							variant="secondary"
							busy={busy === "hrouter-test"}
							onClick={() => action("hrouter-test", () => post("/api/settings/hrouter/test"))}
						>
							测试连接
						</Button>
					</div>
				</Form>
			</div>
			<div className="provider-settings">
				<nav className="provider-breadcrumb" aria-label="平台设置路径">
					<ol>
						<li>平台设置</li>
						<li>联网平台</li>
						<li aria-current="page">{activeProvider ? providerShortLabel(activeProvider.providerId) : "加载中"}</li>
					</ol>
				</nav>
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
		</section>
	);
}
