import { z } from "zod";

export const MEASUREMENT_VERSION = "geo.visibility-measurement.v2";
export const ALGORITHM_VERSION = "visibility.prompt-weighted.v2";
export const semanticContractSchema = z.strictObject({
	schemaVersion: z.literal("geo.semantic-observation.v1"),
	promptVersion: z.literal("semantic.atomic.v1"),
	modelProvider: z.literal("hrouter"),
	modelId: z.string().min(1),
	modelRevision: z.string().min(1).nullable(),
	endpoint: z.url(),
	validatorVersion: z.literal("semantic.evidence.v1"),
	adjudicationPolicyVersion: z.literal("independent-agreement.v1"),
});
export const measurementContractSchema = z
	.strictObject({
		contractVersion: z.literal(MEASUREMENT_VERSION),
		sampling: z.strictObject({
			mode: z.enum(["quick", "formal"]),
			repeats: z.int().min(1).max(10),
			executionWindows: z
				.array(z.string().regex(/^PT\d+M$/))
				.min(1)
				.max(10),
			minimumSuccessfulRepeatsPerPrompt: z.int().min(1).max(10),
			minimumPromptCoverage: z.number().min(0).max(1),
		}),
		semantic: semanticContractSchema,
		metrics: z.strictObject({
			algorithmVersion: z.literal(ALGORITHM_VERSION),
			intervalMethod: z.literal("cluster-bootstrap-percentile"),
			bootstrapIterations: z.int().min(100).max(10_000),
			bootstrapSeed: z.string().min(1),
			minimumEligiblePrompts: z.int().min(2),
			minimumParseCoverage: z.number().min(0).max(1),
			maximumIntervalWidth: z.number().positive().max(1),
			reportabilityPolicyVersion: z.literal("coverage-gates.v1"),
			driftPolicyVersion: z.literal("paired-delta95.v1"),
		}),
		surfaces: z.strictObject({
			api: z.strictObject({ enabled: z.literal(true) }),
			consumerApp: z.strictObject({ enabled: z.literal(false), contractVersion: z.null() }),
		}),
	})
	.superRefine((value, context) => {
		if (
			value.sampling.executionWindows.length !== value.sampling.repeats ||
			value.sampling.minimumSuccessfulRepeatsPerPrompt > value.sampling.repeats ||
			(value.sampling.mode === "quick" && value.sampling.repeats !== 1)
		)
			context.addIssue({ code: "custom", message: "采样窗口、重复次数与最小有效数不一致" });
	});
export type FrozenMeasurementContract = z.infer<typeof measurementContractSchema>;
export type SemanticContract = z.infer<typeof semanticContractSchema>;

const spanSchema = z.strictObject({ start: z.int().nonnegative(), end: z.int().positive(), text: z.string().min(1) });
export const semanticObservationSchema = z.strictObject({
	schemaVersion: z.literal("geo.semantic-observation.v1"),
	parseStatus: z.enum(["valid", "needs_review", "failed"]),
	answerIntent: z.enum(["purchase_recommendation", "comparison", "informational", "other"]),
	hasExplicitRecommendationList: z.boolean(),
	brandSignals: z
		.array(
			z.strictObject({
				brandId: z.string().min(1),
				mention: z.boolean(),
				context: z.enum(["recommendation", "comparison", "factual", "warning", "exclusion"]),
				sentiment: z.enum(["positive", "neutral", "negative", "mixed", "unclear"]),
				recommendation: z.enum(["explicit", "implicit", "none", "against"]),
				rank: z.int().positive().nullable(),
				evidenceSpans: z.array(spanSchema).max(20),
			}),
		)
		.max(100),
	ambiguityReasons: z.array(z.string().min(1)).max(30),
});
export type SemanticObservation = z.infer<typeof semanticObservationSchema>;
export type SemanticBrand = { id: string; name: string; aliases: string[] };
export type SemanticValidation = {
	status: "valid" | "needs_review" | "failed";
	issues: string[];
	observation: SemanticObservation | null;
};

function aliasInText(text: string, alias: string): boolean {
	const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`${/^[a-z0-9]/i.test(alias) ? "(?<![a-z0-9_])" : ""}${escaped}${/[a-z0-9]$/i.test(alias) ? "(?![a-z0-9_])" : ""}`,
		"iu",
	).test(text);
}

type BrandSignal = SemanticObservation["brandSignals"][number];
function checkEvidence(
	signal: BrandSignal,
	answer: string,
	brand: SemanticBrand,
	brands: SemanticBrand[],
): { issues: string[]; ambiguous: boolean } {
	const issues: string[] = [];
	for (const span of signal.evidenceSpans)
		if (span.end <= span.start || span.end > answer.length || answer.slice(span.start, span.end) !== span.text)
			issues.push("证据片段与原文或偏移不一致");
	const aliases = [...new Set([brand.name, ...brand.aliases].map((v) => v.trim()).filter(Boolean))];
	const supported = aliases.filter((alias) => signal.evidenceSpans.some((span) => aliasInText(span.text, alias)));
	if (signal.mention && !supported.length) issues.push("品牌提及缺少支持该品牌的原文证据");
	const ambiguous =
		signal.mention &&
		supported.length > 0 &&
		supported.every((alias) =>
			brands.some(
				(other) =>
					other.id !== brand.id &&
					[other.name, ...other.aliases].some((value) => value.toLowerCase() === alias.toLowerCase()),
			),
		);
	return { issues, ambiguous };
}
function rankSupported(signal: BrandSignal, brand: SemanticBrand): boolean {
	if (signal.rank === null) return true;
	const chinese = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][signal.rank - 1];
	const marker = `${signal.rank}\\s*[.)、：:|]${chinese ? `|${chinese}[、.]|第(?:${chinese}|${signal.rank})(?:名|位)` : ""}`;
	const numbered = new RegExp(`(?:^|\\n)\\s*(?:\\|\\s*)?(?:${marker})\\s*([^\\n]+)`, "u");
	return signal.evidenceSpans.some((span) => {
		const line = span.text.match(numbered)?.[1];
		return Boolean(line && [brand.name, ...brand.aliases].filter(Boolean).some((alias) => aliasInText(line, alias)));
	});
}
function checkSignal(
	signal: BrandSignal,
	observation: SemanticObservation,
	answer: string,
	brands: SemanticBrand[],
): { issues: string[]; ambiguous: boolean } {
	const brand = brands.find((item) => item.id === signal.brandId);
	if (!brand) return { issues: ["未知品牌 ID"], ambiguous: false };
	const checked = checkEvidence(signal, answer, brand, brands);
	const positive = ["explicit", "implicit"].includes(signal.recommendation);
	if (!signal.mention && (signal.rank !== null || signal.recommendation !== "none"))
		checked.issues.push("未提及品牌不能被推荐或排名");
	if (positive && (["warning", "exclusion"].includes(signal.context) || signal.sentiment === "negative"))
		checked.ambiguous = true;
	if (signal.rank !== null && (!observation.hasExplicitRecommendationList || !positive))
		checked.issues.push("名次必须来自明确正向推荐列表");
	if (!rankSupported(signal, brand)) checked.issues.push("名次缺少带列表标号及品牌的原文证据");
	return checked;
}
/** Offsets are UTF-16 offsets into the unchanged answer; normalization must never invent evidence. */
export function validateSemanticObservation(raw: unknown, answer: string, brands: SemanticBrand[]): SemanticValidation {
	const parsed = semanticObservationSchema.safeParse(raw);
	if (!parsed.success) return { status: "failed", issues: ["语义结构不符合严格 Schema"], observation: null };
	const observation = parsed.data;
	const checked = observation.brandSignals.map((signal) => checkSignal(signal, observation, answer, brands));
	const issues = checked.flatMap((result) => result.issues);
	const duplicate = new Set(observation.brandSignals.map((s) => s.brandId)).size !== observation.brandSignals.length;
	const ambiguous =
		duplicate ||
		checked.some((r) => r.ambiguous) ||
		observation.ambiguityReasons.length > 0 ||
		observation.parseStatus === "needs_review";
	if (duplicate) issues.push("同一品牌存在多条信号，需消除冲突后复核");
	const status =
		checked.some((r) => r.issues.length) || observation.parseStatus === "failed"
			? "failed"
			: ambiguous
				? "needs_review"
				: "valid";
	return { status, issues: [...issues, ...observation.ambiguityReasons], observation };
}

/** Review does not silently replace a conflicting first pass. A human may resolve it in an audited new observation. */
export function semanticAgreement(left: SemanticObservation, right: SemanticObservation): boolean {
	const key = (value: SemanticObservation) =>
		JSON.stringify({
			intent: value.answerIntent,
			list: value.hasExplicitRecommendationList,
			brands: [...value.brandSignals]
				.sort((a, b) => a.brandId.localeCompare(b.brandId))
				.map(({ evidenceSpans: _spans, ...signal }) => signal),
		});
	return key(left) === key(right);
}
