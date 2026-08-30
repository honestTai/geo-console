import { z } from "zod";

export const engineSurfaceSchema = z.enum(["deepseek", "kimi"]);

export const captureStatusSchema = z.enum([
	"complete",
	"no_answer",
	"login_required",
	"challenge_required",
	"rate_limited",
	"page_contract_changed",
	"timeout",
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
	"unknown",
]);

export const citationSourceSchema = z.object({
	url: z.url(),
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

const queryCaptureBaseSchema = z.object({
	schemaVersion: z.literal("geo.query-capture.v1"),
	captureId: z.string().min(1),
	jobId: z.string().min(1),
	projectId: z.string().min(1),
	promptId: z.string().min(1),
	prompt: z.string().trim().min(1),
	engine: engineSurfaceSchema,
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

export const queryCaptureSchema = queryCaptureBaseSchema.superRefine((capture, context) => {
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

export const runArtifactSchema = z.object({
	schemaVersion: z.literal("geo.run-artifact.v1"),
	runId: z.string().min(1),
	projectId: z.string().min(1),
	startedAt: z.iso.datetime(),
	completedAt: z.iso.datetime().nullable(),
	captures: z.array(queryCaptureSchema),
});

export type EngineSurface = z.infer<typeof engineSurfaceSchema>;
export type CaptureStatus = z.infer<typeof captureStatusSchema>;
export type CaptureFailureCode = z.infer<typeof captureFailureCodeSchema>;
export type CitationSource = z.infer<typeof citationSourceSchema>;
export type BrandMatch = z.infer<typeof brandMatchSchema>;
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
export type QueryCapture = z.infer<typeof queryCaptureSchema>;
export type RunArtifact = z.infer<typeof runArtifactSchema>;
