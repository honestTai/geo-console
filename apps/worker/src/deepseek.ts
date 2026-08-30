import { readSecret } from "@geo/core";
import { z } from "zod";

const defaultModel = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");

export async function deepSeekStructured<T>(options: {
	name: string;
	schema: Record<string, unknown>;
	instructions: string;
	input: string;
	validate: z.ZodType<T>;
}): Promise<T> {
	const apiKey = await readSecret("deepseek_api_key");
	if (!apiKey) throw new Error("尚未配置 DeepSeek API Key，请先进入平台设置保存密钥");
	const response = await fetch(`${baseUrl}/v1/responses`, {
		method: "POST",
		signal: AbortSignal.timeout(120_000),
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: defaultModel,
			instructions: options.instructions,
			input: options.input,
			text: { format: { type: "json_schema", name: options.name, strict: true, schema: options.schema } },
		}),
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const detail = typeof body.error === "object" && body.error ? JSON.stringify(body.error) : JSON.stringify(body);
		throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）：${detail.slice(0, 500)}`);
	}
	const outputText =
		typeof body.output_text === "string"
			? body.output_text
			: Array.isArray(body.output)
				? body.output
						.flatMap((item) => {
							const content = (item as { content?: unknown[] }).content;
							return Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "") : [];
						})
						.join("")
				: "";
	if (!outputText) throw new Error("DeepSeek 没有返回结构化正文");
	let parsed: unknown;
	try {
		parsed = JSON.parse(outputText);
	} catch {
		throw new Error("DeepSeek 返回的内容不是有效 JSON");
	}
	return options.validate.parse(parsed);
}

const analysisSchema = z.object({
	profile: z.object({
		businessSummary: z.string().min(1),
		products: z.array(z.string()).max(20),
		serviceRegions: z.array(z.string()).max(20),
		differentiators: z.array(z.string()).max(20),
		evidenceGaps: z.array(z.string()).max(20),
	}),
	competitors: z
		.array(z.object({ name: z.string().min(1), domain: z.string().min(1), aliases: z.array(z.string()) }))
		.max(5),
	prompts: z
		.array(z.object({ question: z.string().min(4), intent: z.string().min(1), tags: z.array(z.string()) }))
		.min(1)
		.max(20),
});

export async function analyzeCustomer(input: {
	name: string;
	websiteUrl: string;
	region: string;
	language: string;
	businessFocus: string | null;
	knownCompetitors: string[];
	pages: Array<{ id: string; url: string; title: string | null; text: string }>;
}): Promise<z.infer<typeof analysisSchema>> {
	const pageEvidence = input.pages
		.map((page) => `证据 ${page.id}\nURL: ${page.url}\n标题: ${page.title ?? ""}\n正文: ${page.text.slice(0, 6000)}`)
		.join("\n\n");
	return deepSeekStructured({
		name: "customer_geo_profile",
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["profile", "competitors", "prompts"],
			properties: {
				profile: {
					type: "object",
					additionalProperties: false,
					required: ["businessSummary", "products", "serviceRegions", "differentiators", "evidenceGaps"],
					properties: {
						businessSummary: { type: "string" },
						products: { type: "array", items: { type: "string" }, maxItems: 20 },
						serviceRegions: { type: "array", items: { type: "string" }, maxItems: 20 },
						differentiators: { type: "array", items: { type: "string" }, maxItems: 20 },
						evidenceGaps: { type: "array", items: { type: "string" }, maxItems: 20 },
					},
				},
				competitors: {
					type: "array",
					maxItems: 5,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["name", "domain", "aliases"],
						properties: {
							name: { type: "string" },
							domain: { type: "string" },
							aliases: { type: "array", items: { type: "string" } },
						},
					},
				},
				prompts: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["question", "intent", "tags"],
						properties: {
							question: { type: "string" },
							intent: { type: "string" },
							tags: { type: "array", items: { type: "string" } },
						},
					},
				},
			},
		},
		instructions:
			"你是GEO研究分析师。只根据提供的官网证据建立客户画像。竞品必须是真实、同地区、同业务的企业；无法确认域名时不要列出。问题必须是潜在购买者会向AI提出的自然问题，不得写入虚构事实。输出指定JSON。",
		input: `客户：${input.name}\n官网：${input.websiteUrl}\n地区：${input.region}\n语言：${input.language}\n业务重点：${input.businessFocus ?? "未提供"}\n已知竞品：${input.knownCompetitors.join("、") || "未提供"}\n\n${pageEvidence}`,
		validate: analysisSchema,
	});
}

export const getDeepSeekModel = (): string => defaultModel;
