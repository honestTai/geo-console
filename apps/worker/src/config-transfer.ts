import type { Database, SearchProviderId } from "@geo/core";
import { readEncryptedCredential, searchProviderIds } from "@geo/core";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { z } from "zod";
import { getHRouterConfig, writeHRouterSettings } from "./hrouter";
import { createLibraryQuestion } from "./knowledge-base";
import { providerDefinitions } from "./providers";
import { parseJsonColumn } from "./utils";

/**
 * 机构级配置的导入/导出：平台设置（不含任何密钥）与问题知识库。
 * 用于把本机验收环境或旧机构的配置搬到新环境；密钥永远不出库，导入后仍需在目标环境单独填写。
 */

export const SETTINGS_BUNDLE_KIND = "geo-settings";
export const KNOWLEDGE_BUNDLE_KIND = "geo-knowledge";

const providerBundleSchema = z.object({
	providerId: z.enum(searchProviderIds),
	enabled: z.boolean().default(false),
	model: z.string().trim().min(1),
	endpoint: z.url(),
	secondaryEndpoint: z.url().nullable().optional(),
	options: z.record(z.string(), z.unknown()).default({}),
});

const settingsBundleSchema = z.object({
	kind: z.literal(SETTINGS_BUNDLE_KIND),
	version: z.literal(1),
	hrouter: z
		.object({
			baseUrl: z.url(),
			model: z
				.string()
				.trim()
				.regex(/^gpt(?:-|\.)/i, "HRouter Agent 模型必须是 GPT 系列")
				.nullable(),
			thinkingLevel: z.string(),
		})
		.optional(),
	providers: z.array(providerBundleSchema).default([]),
});

export type SettingsBundle = z.infer<typeof settingsBundleSchema>;

export async function exportSettings(
	database: Database,
	organizationId: string,
): Promise<SettingsBundle & { exportedAt: string }> {
	const hrouter = await getHRouterConfig(database, organizationId);
	const rows = await database.query<Record<string, unknown>>(
		"SELECT provider_id,enabled,model,endpoint,search_strategy FROM provider_configs WHERE organization_id=$1 ORDER BY provider_id",
		[organizationId],
	);
	return {
		kind: SETTINGS_BUNDLE_KIND,
		version: 1,
		exportedAt: new Date().toISOString(),
		hrouter: { baseUrl: hrouter.baseUrl, model: hrouter.model, thinkingLevel: hrouter.thinkingLevel },
		providers: rows.rows.map((row) => {
			const providerId = String(row.provider_id) as SearchProviderId;
			const strategy = parseJsonColumn<Record<string, unknown>>(
				row.search_strategy as string | Record<string, unknown>,
			);
			const { secondaryEndpoint, ...options } =
				strategy.options && typeof strategy.options === "object" ? (strategy.options as Record<string, unknown>) : {};
			return {
				providerId,
				enabled: Boolean(row.enabled),
				model: String(row.model),
				endpoint: String(row.endpoint),
				secondaryEndpoint:
					typeof secondaryEndpoint === "string"
						? secondaryEndpoint
						: (providerDefinitions[providerId].secondaryEndpoint ?? null),
				options,
			};
		}),
	};
}

export type SettingsImportResult = {
	hrouter: { applied: boolean; note: string | null };
	providers: Array<{ providerId: SearchProviderId; enabled: boolean; note: string | null }>;
};

export async function importSettings(
	database: Database,
	organizationId: string,
	input: unknown,
): Promise<SettingsImportResult> {
	const bundle = settingsBundleSchema.parse(input);
	const result: SettingsImportResult = { hrouter: { applied: false, note: null }, providers: [] };
	if (bundle.hrouter) {
		await writeHRouterSettings(database, organizationId, bundle.hrouter);
		const configured = Boolean(await readEncryptedCredential(database, "hrouter_api_key", organizationId));
		result.hrouter = { applied: true, note: configured ? null : "HRouter API Key 未随配置导出，需在本机构单独填写" };
	}
	for (const provider of bundle.providers) {
		const definition = providerDefinitions[provider.providerId];
		const primary = await readEncryptedCredential(database, definition.credentialKey, organizationId);
		const secondary = definition.secondaryCredentialKey
			? await readEncryptedCredential(database, definition.secondaryCredentialKey, organizationId)
			: "not-required";
		const keysReady = Boolean(primary && secondary);
		// 密钥不在导出包里：目标机构没有密钥时不能把平台置为启用，否则采集会立刻失败
		const enabled = provider.enabled && keysReady;
		await database.query(
			`UPDATE provider_configs SET enabled=$2,model=$3,endpoint=$4,
			 search_strategy=$5::jsonb,adapter_version=$6,updated_at=now() WHERE organization_id=$7 AND provider_id=$1`,
			[
				provider.providerId,
				enabled,
				provider.model,
				provider.endpoint,
				JSON.stringify({
					forced: true,
					returnSources: true,
					options: {
						...provider.options,
						secondaryEndpoint: provider.secondaryEndpoint ?? definition.secondaryEndpoint,
					},
				}),
				ADAPTER_VERSION,
				organizationId,
			],
		);
		result.providers.push({
			providerId: provider.providerId,
			enabled,
			note: provider.enabled && !keysReady ? "缺少 API Key，已按停用导入；填写密钥后再启用" : null,
		});
	}
	return result;
}

const knowledgeQuestionSchema = z.object({
	industry: z.string().trim().min(1).max(120),
	question: z.string().trim().min(4).max(500),
	intent: z.string().trim().min(1).max(120),
	topic: z.string().trim().max(120).nullable().optional(),
	persona: z.string().trim().max(120).nullable().optional(),
	tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});

const knowledgeBundleSchema = z.object({
	kind: z.literal(KNOWLEDGE_BUNDLE_KIND),
	version: z.literal(1),
	questions: z.array(knowledgeQuestionSchema).max(5000),
});

export type KnowledgeBundle = z.infer<typeof knowledgeBundleSchema>;

export async function exportKnowledge(
	database: Database,
	organizationId: string,
	industry?: string | null,
): Promise<KnowledgeBundle & { exportedAt: string }> {
	const industryValue = industry?.trim() || null;
	const rows = await database.query<Record<string, unknown>>(
		`SELECT industry,question,intent,topic,persona,tags FROM prompt_library_questions
		 WHERE organization_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR lower(industry)=lower($2))
		 ORDER BY industry,created_at`,
		[organizationId, industryValue],
	);
	return {
		kind: KNOWLEDGE_BUNDLE_KIND,
		version: 1,
		exportedAt: new Date().toISOString(),
		questions: rows.rows.map((row) => ({
			industry: String(row.industry),
			question: String(row.question),
			intent: String(row.intent),
			topic: typeof row.topic === "string" ? row.topic : null,
			persona: typeof row.persona === "string" ? row.persona : null,
			tags: parseJsonColumn<string[]>(row.tags as string | string[]),
		})),
	};
}

export type KnowledgeImportResult = { total: number; imported: number; skipped: number };

/** 逐条写入；同行业同问题已存在时跳过而不是报错，便于反复导入同一份包。 */
export async function importKnowledge(
	database: Database,
	organizationId: string,
	actorUserId: string | null,
	input: unknown,
): Promise<KnowledgeImportResult> {
	const bundle = knowledgeBundleSchema.parse(input);
	let imported = 0;
	let skipped = 0;
	for (const question of bundle.questions) {
		try {
			await createLibraryQuestion(database, organizationId, actorUserId, {
				...question,
				topic: question.topic || null,
				persona: question.persona || null,
			});
			imported += 1;
		} catch (error) {
			if (error instanceof Error && error.message.includes("已存在相同问题")) skipped += 1;
			else throw error;
		}
	}
	return { total: bundle.questions.length, imported, skipped };
}
