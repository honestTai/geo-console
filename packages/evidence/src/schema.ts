import { z } from "zod";

export const legacyConsumerSurfaceSchema = z.enum(["deepseek", "kimi"]);
export const searchProviderSchema = z.enum(["deepseek_api", "kimi_api", "doubao_api", "qwen_api", "yuanbao_hunyuan"]);
export const engineSurfaceSchema = z.union([legacyConsumerSurfaceSchema, searchProviderSchema]);

export const captureStatusSchema = z.enum([
	"complete",
	"no_answer",
	"login_required",
	"challenge_required",
	"rate_limited",
	"page_contract_changed",
	"timeout",
	"auth_required",
	"search_not_triggered",
	"model_unavailable",
	"protocol_changed",
	"failed",
]);

export const captureFailureCodeSchema = z.enum([
	"navigation_failed",
	"login_expired",
	"verification_required",
	"prompt_rejected",
	"answer_timeout",
	"page_contract_changed",
	"rate_limited",
	"no_answer",
	"authentication_failed",
	"search_not_triggered",
	"model_unavailable",
	"protocol_changed",
	"provider_timeout",
	"quota_exceeded",
	"provider_error",
	"unknown",
]);

export const capabilityVisibilitySchema = z.enum(["available", "partial", "unavailable"]);

export const citationSourceSchema = z.object({
	url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "引用来源只允许 HTTP(S)"),
	domain: z.string().min(1),
	title: z.string().trim().min(1).nullable(),
	position: z.int().positive(),
	isCitation: z.boolean(),
});

export const brandMatchSchema = z.object({
	brandId: z.string().min(1),
	matchedAlias: z.string().min(1),
	position: z.int().nonnegative(),
});

export const captureEvidenceSchema = z.object({
	captureNodeId: z.string().min(1),
	screenshotObjectKey: z.string().min(1).nullable(),
	traceObjectKey: z.string().min(1).nullable(),
	pageUrl: z.url(),
});

const queryCaptureV1BaseSchema = z.object({
	schemaVersion: z.literal("geo.query-capture.v1"),
	captureId: z.string().min(1),
	jobId: z.string().min(1),
	projectId: z.string().min(1),
	promptId: z.string().min(1),
	prompt: z.string().trim().min(1),
	engine: legacyConsumerSurfaceSchema,
	captureMode: z.literal("consumer_surface"),
	attempt: z.int().positive(),
	capturedAt: z.iso.datetime(),
	locale: z.string().min(2),
	region: z.string().min(2),
	status: captureStatusSchema,
	answerText: z.string().trim().min(1).nullable(),
	brandMatches: z.array(brandMatchSchema),
	sources: z.array(citationSourceSchema),
	queryFanOut: z.array(z.string().trim().min(1)),
	evidence: captureEvidenceSchema,
	adapterVersion: z.string().min(1),
	contentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.nullable(),
	failureCode: captureFailureCodeSchema.nullable(),
	failureMessage: z.string().trim().min(1).nullable(),
});

export const queryCaptureV1Schema = queryCaptureV1BaseSchema.superRefine((capture, context) => {
	if (capture.status === "complete" && capture.answerText === null) {
		context.addIssue({
			code: "custom",
			message: "完整采集必须包含回答正文",
			path: ["answerText"],
		});
	}
	if (capture.status === "complete" && capture.contentHash === null) {
		context.addIssue({ code: "custom", message: "完整采集必须包含正文哈希", path: ["contentHash"] });
	}

	if (capture.status !== "complete" && capture.failureCode === null) {
		context.addIssue({
			code: "custom",
			message: "非完整采集必须说明失败原因",
			path: ["failureCode"],
		});
	}
});

export const providerUsageSchema = z.object({
	inputTokens: z.int().nonnegative().optional(),
	outputTokens: z.int().nonnegative().optional(),
	totalTokens: z.int().nonnegative().optional(),
	searchRequests: z.int().nonnegative().optional(),
});

export const apiCaptureEvidenceSchema = z.object({
	endpoint: z.url(),
	rawResponseObjectKey: z.string().min(1).nullable(),
	requestId: z.string().trim().min(1).nullable(),
});

const queryCaptureV2BaseSchema = z.object({
	schemaVersion: z.literal("geo.query-capture.v2"),
	captureId: z.string().min(1),
	jobId: z.string().min(1),
	sampleKey: z.string().min(1).optional(),
	projectId: z.string().min(1),
	promptId: z.string().min(1),
	prompt: z.string().trim().min(1),
	engine: searchProviderSchema,
	captureMode: z.literal("llm_search_api"),
	attempt: z.int().positive(),
	capturedAt: z.iso.datetime(),
	locale: z.string().min(2),
	region: z.string().min(2),
	status: captureStatusSchema,
	answerText: z.string().trim().min(1).nullable(),
	brandMatches: z.array(brandMatchSchema),
	sources: z.array(citationSourceSchema),
	queryFanOut: z.array(z.string().trim().min(1)),
	sourceVisibility: capabilityVisibilitySchema,
	fanoutVisibility: capabilityVisibilitySchema,
	evidence: apiCaptureEvidenceSchema,
	model: z.string().trim().min(1),
	protocol: z.string().trim().min(1),
	searchToolVersion: z.string().trim().min(1),
	adapterVersion: z.string().trim().min(1),
	executorId: z.string().trim().min(1),
	usage: providerUsageSchema.nullable(),
	costMicros: z.int().nonnegative().nullable(),
	latencyMs: z.int().nonnegative(),
	contentHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.nullable(),
	failureCode: captureFailureCodeSchema.nullable(),
	failureMessage: z.string().trim().min(1).nullable(),
});

export const queryCaptureV2Schema = queryCaptureV2BaseSchema.superRefine((capture, context) => {
	if (capture.status === "complete" && capture.answerText === null) {
		context.addIssue({ code: "custom", message: "完整采集必须包含回答正文", path: ["answerText"] });
	}
	if (capture.status === "complete" && capture.contentHash === null) {
		context.addIssue({ code: "custom", message: "完整采集必须包含正文哈希", path: ["contentHash"] });
	}
	if (capture.status !== "complete" && capture.failureCode === null) {
		context.addIssue({ code: "custom", message: "非完整采集必须说明失败原因", path: ["failureCode"] });
	}
	if (capture.engine === "yuanbao_hunyuan" && capture.protocol !== "yuanbao-search+hunyuan-synthesis") {
		context.addIssue({
			code: "custom",
			message: "元宝采集必须使用并标明元宝搜索源 + 混元合成口径",
			path: ["protocol"],
		});
	}
});

export const queryCaptureSchema = z.union([queryCaptureV1Schema, queryCaptureV2Schema]);

export const runArtifactSchema = z.object({
	schemaVersion: z.literal("geo.run-artifact.v1"),
	runId: z.string().min(1),
	projectId: z.string().min(1),
	startedAt: z.iso.datetime(),
	completedAt: z.iso.datetime().nullable(),
	captures: z.array(queryCaptureSchema),
});

export type EngineSurface = z.infer<typeof engineSurfaceSchema>;
export type SearchProvider = z.infer<typeof searchProviderSchema>;
export type CaptureStatus = z.infer<typeof captureStatusSchema>;
export type CaptureFailureCode = z.infer<typeof captureFailureCodeSchema>;
export type CitationSource = z.infer<typeof citationSourceSchema>;
export type BrandMatch = z.infer<typeof brandMatchSchema>;
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
export type ApiCaptureEvidence = z.infer<typeof apiCaptureEvidenceSchema>;
export type QueryCapture = z.infer<typeof queryCaptureSchema>;
export type QueryCaptureV1 = z.infer<typeof queryCaptureV1Schema>;
export type QueryCaptureV2 = z.infer<typeof queryCaptureV2Schema>;
export type RunArtifact = z.infer<typeof runArtifactSchema>;
