import { randomUUID } from "node:crypto";
import {
	type Database,
	readEncryptedCredential,
	type SearchProviderId,
	type SecretKey,
	searchProviderIds,
	writeEncryptedCredential,
} from "@geo/core";
import {
	ADAPTER_VERSION,
	createSearchProviderAdapter,
	type ProviderConfig,
	type SearchProviderAdapter,
} from "@geo/search-providers";
import { z } from "zod";
import { parseJsonColumn } from "./utils";

type ProviderDefinition = Omit<ProviderConfig, "apiKey" | "secondaryApiKey"> & {
	label: string;
	credentialKey: SecretKey;
	secondaryCredentialKey?: SecretKey;
	disclosure: string;
};

export const providerDefinitions: Record<SearchProviderId, ProviderDefinition> = {
	deepseek_api: {
		providerId: "deepseek_api",
		label: "DeepSeek 联网 API",
		endpoint: "https://api.deepseek.com/v1",
		model: "deepseek-v4-flash",
		protocol: "deepseek-responses",
		searchToolVersion: "web_search",
		credentialKey: "deepseek_api_key",
		disclosure: "DeepSeek Responses API 联网回答，不等同于 DeepSeek App 页面回答。",
	},
	kimi_api: {
		providerId: "kimi_api",
		label: "Kimi 联网 API",
		endpoint: "https://api.moonshot.ai/v1",
		model: "kimi-k3",
		protocol: "moonshot-chat-formula",
		searchToolVersion: "moonshot/web-search:latest",
		credentialKey: "kimi_api_key",
		disclosure: "Kimi API 通过官方 Web Search Formula 生成，不等同于 Kimi App 页面回答。",
	},
	doubao_api: {
		providerId: "doubao_api",
		label: "豆包・火山方舟联网 API",
		endpoint: "https://ark.cn-beijing.volces.com/api/v3",
		model: "doubao-seed-1-6-250615",
		protocol: "ark-responses",
		searchToolVersion: "web_search",
		credentialKey: "doubao_api_key",
		disclosure: "火山方舟 Responses 联网回答，不等同于豆包 App 页面回答。",
	},
	qwen_api: {
		providerId: "qwen_api",
		label: "通义千问・DashScope 联网 API",
		endpoint: "https://dashscope.aliyuncs.com/api/v1",
		model: "qwen-plus",
		protocol: "dashscope-native-generation",
		searchToolVersion: "native-web-search",
		credentialKey: "qwen_api_key",
		disclosure: "DashScope 原生联网回答，不等同于通义 App 页面回答。",
	},
	yuanbao_hunyuan: {
		providerId: "yuanbao_hunyuan",
		label: "元宝搜索源 + 混元合成",
		endpoint: "https://api.wsa.cloud.tencent.com/SearchPro",
		secondaryEndpoint: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
		model: "hunyuan-turbos-latest",
		protocol: "yuanbao-search+hunyuan-synthesis",
		searchToolVersion: "SearchPro",
		credentialKey: "yuanbao_api_key",
		secondaryCredentialKey: "hunyuan_api_key",
		disclosure: "腾讯联网搜索 API 提供信源，由混元模型合成；不是元宝 App 真实回答。",
	},
};

export async function ensureProviderConfigs(database: Database, organizationId?: string): Promise<void> {
	const organizations = organizationId
		? [{ id: organizationId }]
		: (await database.query<{ id: string }>("SELECT id FROM organizations ORDER BY created_at")).rows;
	for (const organization of organizations)
		for (const id of searchProviderIds) {
			const definition = providerDefinitions[id];
			await database.query(
				`INSERT INTO provider_configs
				 (id,organization_id,provider_id,enabled,model,endpoint,protocol,search_strategy,adapter_version)
				 VALUES ($1,$2,$3,false,$4,$5,$6,$7::jsonb,$8)
				 ON CONFLICT (organization_id,provider_id) DO NOTHING`,
				[
					randomUUID(),
					organization.id,
					id,
					definition.model,
					definition.endpoint,
					definition.protocol,
					JSON.stringify({ forced: true, returnSources: true, options: definition.options ?? {} }),
					ADAPTER_VERSION,
				],
			);
		}
}

const updateSchema = z.object({
	enabled: z.boolean(),
	model: z.string().trim().min(1),
	endpoint: z.url(),
	secondaryEndpoint: z.url().optional().nullable(),
	apiKey: z.string().trim().min(10).optional(),
	secondaryApiKey: z.string().trim().min(10).optional(),
	options: z.record(z.string(), z.unknown()).default({}),
});

export async function saveProviderConfig(
	database: Database,
	providerId: SearchProviderId,
	input: unknown,
	organizationId = "default",
): Promise<void> {
	const data = updateSchema.parse(input);
	const definition = providerDefinitions[providerId];
	if (providerId === "yuanbao_hunyuan" && !data.secondaryEndpoint) throw new Error("元宝组合口径必须配置混元端点");
	if (data.apiKey) await writeEncryptedCredential(database, definition.credentialKey, data.apiKey, organizationId);
	if (data.secondaryApiKey && definition.secondaryCredentialKey)
		await writeEncryptedCredential(database, definition.secondaryCredentialKey, data.secondaryApiKey, organizationId);
	if (data.enabled) {
		const primary = await readEncryptedCredential(database, definition.credentialKey, organizationId);
		const secondary = definition.secondaryCredentialKey
			? await readEncryptedCredential(database, definition.secondaryCredentialKey, organizationId)
			: "not-required";
		if (!primary || !secondary) throw new Error("启用平台前必须配置所需 API 密钥");
	}
	await database.query(
		`UPDATE provider_configs SET enabled=$2,model=$3,endpoint=$4,
		 search_strategy=$5::jsonb,adapter_version=$6,updated_at=now() WHERE organization_id=$7 AND provider_id=$1`,
		[
			providerId,
			data.enabled,
			data.model,
			data.endpoint,
			JSON.stringify({
				forced: true,
				returnSources: true,
				options: { ...data.options, secondaryEndpoint: data.secondaryEndpoint ?? definition.secondaryEndpoint },
			}),
			ADAPTER_VERSION,
			organizationId,
		],
	);
}

export async function getProviderSettings(database: Database, organizationId = "default"): Promise<unknown[]> {
	const rows = await database.query<Record<string, unknown>>(
		"SELECT * FROM provider_configs WHERE organization_id=$1 ORDER BY provider_id",
		[organizationId],
	);
	return Promise.all(
		rows.rows.map(async (row) => {
			const providerId = String(row.provider_id) as SearchProviderId;
			const definition = providerDefinitions[providerId];
			const strategy = parseJsonColumn<Record<string, unknown>>(
				row.search_strategy as string | Record<string, unknown>,
			);
			const options = strategy.options && typeof strategy.options === "object" ? strategy.options : {};
			return {
				providerId,
				label: definition.label,
				disclosure: definition.disclosure,
				enabled: Boolean(row.enabled),
				configured: Boolean(await readEncryptedCredential(database, definition.credentialKey, organizationId)),
				secondaryConfigured: definition.secondaryCredentialKey
					? Boolean(await readEncryptedCredential(database, definition.secondaryCredentialKey, organizationId))
					: null,
				model: row.model,
				endpoint: row.endpoint,
				secondaryEndpoint:
					(options as Record<string, unknown>).secondaryEndpoint ?? definition.secondaryEndpoint ?? null,
				protocol: row.protocol,
				searchToolVersion: definition.searchToolVersion,
				lastTestStatus: row.last_test_status,
				lastTestMessage: row.last_test_message,
				lastTestedAt: row.last_tested_at,
			};
		}),
	);
}

export async function buildProviderAdapter(
	database: Database,
	providerId: SearchProviderId,
	frozen?: {
		endpoint: string;
		secondaryEndpoint?: string;
		model: string;
		protocol: string;
		searchToolVersion: string;
		searchStrategy: Record<string, unknown>;
	},
	organizationId = "default",
): Promise<SearchProviderAdapter> {
	const row = (
		await database.query<Record<string, unknown>>(
			"SELECT * FROM provider_configs WHERE organization_id=$1 AND provider_id=$2",
			[organizationId, providerId],
		)
	).rows[0];
	if (!row) throw new Error(`平台 ${providerId} 尚未初始化`);
	const definition = providerDefinitions[providerId];
	const apiKey = await readEncryptedCredential(database, definition.credentialKey, organizationId);
	if (!apiKey) throw new Error(`${definition.label} 尚未配置 API 密钥`);
	const strategy =
		frozen?.searchStrategy ??
		parseJsonColumn<Record<string, unknown>>(row.search_strategy as string | Record<string, unknown>);
	const options =
		strategy.options && typeof strategy.options === "object" ? (strategy.options as Record<string, unknown>) : {};
	const secondaryApiKey = definition.secondaryCredentialKey
		? await readEncryptedCredential(database, definition.secondaryCredentialKey, organizationId)
		: undefined;
	return createSearchProviderAdapter({
		providerId,
		endpoint: frozen?.endpoint ?? String(row.endpoint),
		model: frozen?.model ?? String(row.model),
		protocol: frozen?.protocol ?? String(row.protocol),
		searchToolVersion: frozen?.searchToolVersion ?? definition.searchToolVersion,
		apiKey,
		secondaryEndpoint:
			frozen?.secondaryEndpoint ??
			(typeof options.secondaryEndpoint === "string" ? options.secondaryEndpoint : definition.secondaryEndpoint),
		secondaryApiKey: secondaryApiKey ?? undefined,
		options,
	});
}

export async function testProviderConfig(
	database: Database,
	providerId: SearchProviderId,
	organizationId = "default",
): Promise<unknown> {
	const result = await (await buildProviderAdapter(database, providerId, undefined, organizationId)).testConnection();
	await database.query(
		`UPDATE provider_configs SET last_test_status=$2,last_test_message=$3,last_tested_at=now(),updated_at=now()
		 WHERE organization_id=$4 AND provider_id=$1`,
		[providerId, result.status, result.message, organizationId],
	);
	return result;
}
