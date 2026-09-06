import {
	type FrozenMeasurementContract,
	measurementContractSchema,
	type QueryCaptureV2,
	type SemanticBrand,
	type SemanticContract,
	type SemanticObservation,
	validateSemanticObservation,
} from "@geo/evidence";

export type Reportability = "ready" | "limited" | "unavailable";
export type Interval = [number, number] | null;
export const rateKeys = [
	"brandMentionRate",
	"recommendationRate",
	"explicitRecommendationRate",
	"firstRecommendationRate",
	"monitoredBrandShare",
	"pairwiseAgreement",
	"sourcePresenceRate",
	"citationRate",
	"sourceToCitationRate",
] as const;
export type RateKey = (typeof rateKeys)[number];
type Rates = Record<RateKey, number | null>;
export type AdoptedObservation = {
	id: string;
	captureId: string;
	contract: SemanticContract;
	observation: SemanticObservation;
};
export type PromptMetrics = Rates & {
	promptId: string;
	eligible: boolean;
	successfulRepeats: number;
	validRepeats: number;
	evidenceIds: string[];
	observationIds: string[];
	ranks: number[];
	competitorMentionRates: Record<string, number | null>;
};
export type VisibilityMetrics = Rates & {
	status: Reportability;
	reasons: string[];
	totalCaptures: number;
	answeredCaptures: number;
	plannedCaptures: number;
	validObservations: number;
	plannedPromptCount: number;
	eligiblePromptCount: number;
	captureCoverage: number;
	parseCoverage: number | null;
	promptCoverage: number;
	sourceCoverage: number | null;
	sourceObservedCaptures: number;
	medianRecommendationRank: number | null;
	competitorMentionRates: Record<string, number | null>;
	confidenceIntervals: Record<RateKey, Interval>;
	prompts: PromptMetrics[];
};
export type OverallVisibilityMetrics = Rates & {
	status: Reportability;
	captureCoverage: number;
	parseCoverage: number | null;
	promptCoverage: number;
	plannedPlatformCount: number;
	validPlatformCount: number;
	failedPlatformCount: number;
	dataCoverage: number;
	failureRate: number;
	medianRecommendationRank: number | null;
	confidenceIntervals: Record<RateKey, Interval>;
};
export type VisibilityMetricInput = {
	captures: QueryCaptureV2[];
	observations: AdoptedObservation[];
	promptIds: string[];
	targetBrandId: string;
	targetDomains: string[];
	brands: SemanticBrand[];
	contract: FrozenMeasurementContract;
};

export const mean = (values: Array<number | null>): number | null => {
	const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
	return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const ratio = (numerator: number, denominator: number): number | null => (denominator ? numerator / denominator : null);
const normalizeDomain = (domain: string) => domain.toLowerCase().replace(/^www\./, "");
export function canonicalMeasurement(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalMeasurement).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalMeasurement(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function pairwiseAgreement(values: boolean[]): number | null {
	const n = values.length;
	const k = values.filter(Boolean).length;
	return n < 2 ? null : (k * (k - 1) + (n - k) * (n - k - 1)) / (n * (n - 1));
}
function randomGenerator(seed: string): () => number {
	let state = 2166136261;
	for (let i = 0; i < seed.length; i += 1) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
	return () => {
		state += 0x6d2b79f5;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function percentile(values: number[], probability: number): number {
	const offset = (values.length - 1) * probability;
	const lower = Math.floor(offset);
	return values[lower] + (values[Math.ceil(offset)] - values[lower]) * (offset - lower);
}
/** Resamples whole prompt clusters, not individual repeated answers. */
export function clusterInterval<T>(
	clusters: T[],
	statistic: (sample: T[]) => number | null,
	iterations: number,
	seed: string,
): Interval {
	if (clusters.length < 2) return null;
	const random = randomGenerator(seed);
	const estimates: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const value = statistic(
			Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]),
		);
		if (value !== null) estimates.push(value);
	}
	if (estimates.length < iterations * 0.9) return null;
	estimates.sort((a, b) => a - b);
	return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}
export function recommendationRankMedian(
	prompts: PromptMetrics[],
	weights?: Map<PromptMetrics, number>,
): number | null {
	const ranked = prompts.filter((p) => p.ranks.length);
	const totalWeight = ranked.reduce((sum, p) => sum + (weights?.get(p) ?? 1), 0);
	const values = ranked
		.flatMap((p) => p.ranks.map((value) => ({ value, weight: (weights?.get(p) ?? 1) / p.ranks.length / totalWeight })))
		.sort((a, b) => a.value - b.value);
	let sum = 0;
	for (const [index, item] of values.entries()) {
		sum += item.weight;
		if (sum >= 0.5 - 1e-12)
			return Math.abs(sum - 0.5) < 1e-12 && values[index + 1] ? (item.value + values[index + 1].value) / 2 : item.value;
	}
	return null;
}
function promptMetrics(input: VisibilityMetricInput, promptId: string): PromptMetrics {
	const successful = input.captures.filter((c) => c.promptId === promptId && c.status === "complete" && c.answerText);
	const adopted = successful.flatMap((capture) => {
		const candidates = input.observations.filter(
			(item) =>
				item.captureId === capture.captureId &&
				canonicalMeasurement(item.contract) === canonicalMeasurement(input.contract.semantic),
		);
		if (candidates.length !== 1) return [];
		const validation = validateSemanticObservation(candidates[0].observation, capture.answerText ?? "", input.brands);
		return validation.status === "valid" && validation.observation
			? [{ capture, record: candidates[0], semantic: validation.observation }]
			: [];
	});
	const target = adopted.map((item) => item.semantic.brandSignals.find((s) => s.brandId === input.targetBrandId));
	const positive = (signal: (typeof target)[number]) =>
		Boolean(signal?.mention && ["explicit", "implicit"].includes(signal.recommendation));
	const rates = Object.fromEntries(rateKeys.map((key) => [key, null])) as Rates;
	if (adopted.length) {
		rates.brandMentionRate = target.filter((s) => s?.mention).length / adopted.length;
		rates.recommendationRate = target.filter(positive).length / adopted.length;
		rates.explicitRecommendationRate =
			target.filter((s) => positive(s) && s?.recommendation === "explicit").length / adopted.length;
		rates.firstRecommendationRate =
			target.filter((s, i) => positive(s) && s?.rank === 1 && adopted[i].semantic.hasExplicitRecommendationList)
				.length / adopted.length;
		rates.monitoredBrandShare = ratio(
			target.filter((s) => s?.mention).length,
			adopted.reduce((total, item) => total + item.semantic.brandSignals.filter((s) => s.mention).length, 0),
		);
		rates.pairwiseAgreement =
			input.contract.sampling.mode === "quick" ? null : pairwiseAgreement(target.map((s) => Boolean(s?.mention)));
	}
	const observable = successful.filter((c) => c.sourceVisibility !== "unavailable");
	const domains = new Set(input.targetDomains.map(normalizeDomain));
	const present = observable.filter((c) => c.sources.some((s) => domains.has(normalizeDomain(s.domain))));
	const cited = observable.filter((c) => c.sources.some((s) => s.isCitation && domains.has(normalizeDomain(s.domain))));
	rates.sourcePresenceRate = ratio(present.length, observable.length);
	rates.citationRate = ratio(cited.length, observable.length);
	rates.sourceToCitationRate = ratio(cited.length, present.length);
	return {
		...rates,
		promptId,
		eligible: adopted.length >= input.contract.sampling.minimumSuccessfulRepeatsPerPrompt,
		successfulRepeats: successful.length,
		validRepeats: adopted.length,
		evidenceIds: adopted.map((x) => x.capture.captureId).sort(),
		observationIds: adopted.map((x) => x.record.id).sort(),
		ranks: target.flatMap((s, i) =>
			positive(s) && adopted[i].semantic.hasExplicitRecommendationList && s?.rank ? [s.rank] : [],
		),
		competitorMentionRates: Object.fromEntries(
			input.brands
				.filter((b) => b.id !== input.targetBrandId)
				.map(({ id }) => [
					id,
					ratio(
						adopted.filter((x) => x.semantic.brandSignals.some((s) => s.brandId === id && s.mention)).length,
						adopted.length,
					),
				]),
		),
	};
}

export function calculateVisibilityMetrics(input: VisibilityMetricInput): VisibilityMetrics {
	measurementContractSchema.parse(input.contract);
	if (!input.promptIds.length || new Set(input.promptIds).size !== input.promptIds.length)
		throw new Error("冻结问题集必须非空且唯一");
	if (
		new Set(input.brands.map((b) => b.id)).size !== input.brands.length ||
		!input.brands.some((b) => b.id === input.targetBrandId)
	)
		throw new Error("冻结品牌白名单无效");
	const slots = new Set<string>();
	const jobs = new Set<string>();
	for (const capture of input.captures) {
		const slot = `${capture.promptId}:${capture.attempt}`;
		if (
			capture.schemaVersion !== "geo.query-capture.v2" ||
			!input.promptIds.includes(capture.promptId) ||
			capture.attempt < 1 ||
			capture.attempt > input.contract.sampling.repeats ||
			slots.has(slot) ||
			jobs.has(capture.jobId)
		)
			throw new Error("采样不属于冻结范围或业务采样重复");
		slots.add(slot);
		jobs.add(capture.jobId);
	}
	const prompts = [...input.promptIds].sort().map((id) => promptMetrics(input, id));
	const eligible = prompts.filter((p) => p.eligible);
	const answeredCaptures = prompts.reduce((n, p) => n + p.successfulRepeats, 0);
	const validObservations = prompts.reduce((n, p) => n + p.validRepeats, 0);
	const plannedCaptures = input.promptIds.length * input.contract.sampling.repeats;
	const parseCoverage = ratio(validObservations, answeredCaptures);
	const promptCoverage = eligible.length / prompts.length;
	const confidenceIntervals = Object.fromEntries(
		rateKeys.map((key) => [
			key,
			input.contract.sampling.mode === "quick"
				? null
				: clusterInterval(
						eligible.filter((p) => p[key] !== null),
						(sample) => mean(sample.map((p) => p[key])),
						input.contract.metrics.bootstrapIterations,
						`${input.contract.metrics.bootstrapSeed}:${key}`,
					),
		]),
	) as Record<RateKey, Interval>;
	const reasons: string[] = [];
	if (input.contract.sampling.mode === "quick") reasons.push("quick_snapshot");
	if (eligible.length < input.contract.metrics.minimumEligiblePrompts) reasons.push("insufficient_prompts");
	if (promptCoverage < input.contract.sampling.minimumPromptCoverage) reasons.push("insufficient_prompt_coverage");
	if ((parseCoverage ?? 0) < input.contract.metrics.minimumParseCoverage) reasons.push("insufficient_parse_coverage");
	if (
		input.contract.sampling.mode === "formal" &&
		["brandMentionRate", "recommendationRate", "explicitRecommendationRate", "firstRecommendationRate"].some((key) => {
			const interval = confidenceIntervals[key as RateKey];
			return interval !== null && interval[1] - interval[0] > input.contract.metrics.maximumIntervalWidth;
		})
	)
		reasons.push("wide_confidence_interval");
	const rates = Object.fromEntries(rateKeys.map((key) => [key, mean(eligible.map((p) => p[key]))])) as Rates;
	const sourceObservedCaptures = input.captures.filter(
		(c) => c.status === "complete" && c.sourceVisibility !== "unavailable",
	).length;
	return {
		...rates,
		status: !eligible.length ? "unavailable" : reasons.length ? "limited" : "ready",
		reasons,
		totalCaptures: input.captures.length,
		plannedCaptures,
		answeredCaptures,
		validObservations,
		plannedPromptCount: prompts.length,
		eligiblePromptCount: eligible.length,
		captureCoverage: answeredCaptures / plannedCaptures,
		parseCoverage,
		promptCoverage,
		sourceObservedCaptures,
		sourceCoverage: ratio(sourceObservedCaptures, answeredCaptures),
		medianRecommendationRank: recommendationRankMedian(eligible),
		competitorMentionRates: Object.fromEntries(
			input.brands
				.filter((b) => b.id !== input.targetBrandId)
				.map((b) => [b.id, mean(eligible.map((p) => p.competitorMentionRates[b.id]))]),
		),
		prompts,
		confidenceIntervals,
	};
}

export function calculateEqualWeightedOverall(
	platforms: VisibilityMetrics[],
	contract: FrozenMeasurementContract,
): OverallVisibilityMetrics {
	const ready = platforms.filter((p) => p.status === "ready");
	const included = contract.sampling.mode === "quick" ? platforms.filter((p) => p.status !== "unavailable") : ready;
	const rates = Object.fromEntries(rateKeys.map((key) => [key, mean(included.map((p) => p[key]))])) as Rates;
	const ids = [...new Set(included.flatMap((p) => p.prompts.filter((x) => x.eligible).map((x) => x.promptId)))].sort();
	const rankWeights = new Map<PromptMetrics, number>();
	for (const platform of included) {
		const ranked = platform.prompts.filter((p) => p.eligible && p.ranks.length);
		for (const prompt of ranked) rankWeights.set(prompt, 1 / ranked.length);
	}
	const promptIndexes = included.map((p) => new Map(p.prompts.filter((x) => x.eligible).map((x) => [x.promptId, x])));
	const confidenceIntervals = Object.fromEntries(
		rateKeys.map((key) => [
			key,
			contract.sampling.mode === "quick"
				? null
				: clusterInterval(
						ids,
						(sample) =>
							mean(promptIndexes.map((platform) => mean(sample.map((id) => platform.get(id)?.[key] ?? null)))),
						contract.metrics.bootstrapIterations,
						`${contract.metrics.bootstrapSeed}:overall:${key}`,
					),
		]),
	) as Record<RateKey, Interval>;
	return {
		...rates,
		status: ready.length ? "ready" : platforms.some((p) => p.status !== "unavailable") ? "limited" : "unavailable",
		captureCoverage: mean(platforms.map((p) => p.captureCoverage)) ?? 0,
		parseCoverage: mean(platforms.map((p) => p.parseCoverage)),
		promptCoverage: mean(platforms.map((p) => p.promptCoverage)) ?? 0,
		plannedPlatformCount: platforms.length,
		validPlatformCount: ready.length,
		failedPlatformCount: platforms.filter((p) => !p.answeredCaptures).length,
		dataCoverage: ratio(ready.length, platforms.length) ?? 0,
		failureRate: ratio(platforms.filter((p) => !p.answeredCaptures).length, platforms.length) ?? 0,
		medianRecommendationRank: recommendationRankMedian(
			included.flatMap((p) => p.prompts.filter((x) => x.eligible)),
			rankWeights,
		),
		confidenceIntervals,
	};
}

export function pairedDrift(
	before: VisibilityMetrics,
	after: VisibilityMetrics,
	key: RateKey,
	contract: FrozenMeasurementContract,
): {
	status: Reportability;
	delta: number | null;
	previous: number | null;
	current: number | null;
	interval: Interval;
	severity: "high" | "warning" | "observation" | "none";
	promptIds: string[];
} {
	const pairs = before.prompts
		.filter((p) => p.eligible && p[key] !== null)
		.flatMap((p) => {
			const next = after.prompts.find((n) => n.promptId === p.promptId && n.eligible && n[key] !== null);
			return next
				? [
						{
							id: p.promptId,
							previous: p[key] as number,
							current: next[key] as number,
							delta: (next[key] as number) - (p[key] as number),
						},
					]
				: [];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	const delta = mean(pairs.map((p) => p.delta));
	const interval =
		contract.sampling.mode === "quick"
			? null
			: clusterInterval(
					pairs,
					(sample) => mean(sample.map((p) => p.delta)),
					contract.metrics.bootstrapIterations,
					`${contract.metrics.bootstrapSeed}:paired:${key}`,
				);
	const ready =
		contract.sampling.mode === "formal" &&
		before.status === "ready" &&
		after.status === "ready" &&
		pairs.length >= contract.metrics.minimumEligiblePrompts &&
		pairs.length / before.plannedPromptCount >= contract.sampling.minimumPromptCoverage;
	const significant = ready && interval !== null && interval[1] < 0;
	return {
		previous: mean(pairs.map((p) => p.previous)),
		status: delta === null ? "unavailable" : ready ? "ready" : "limited",
		current: mean(pairs.map((p) => p.current)),
		delta,
		interval,
		severity:
			delta === null || delta > -0.1 + 1e-12
				? "none"
				: !significant
					? "observation"
					: delta <= -0.2 + 1e-12
						? "high"
						: "warning",
		promptIds: pairs.map((p) => p.id),
	};
}
