import type { QueryCapture } from "@geo/evidence";

export type VisibilityMetricInput = {
	captures: QueryCapture[];
	targetBrandId: string;
	targetDomains: string[];
	competitorBrandIds?: string[];
};

export type VisibilityMetrics = {
	totalCaptures: number;
	answeredCaptures: number;
	answerCoverage: number;
	brandMentionRate: number;
	firstRecommendationRate: number;
	brandShareOfVoice: number;
	repeatConsistency: number | null;
	sourceObservedCaptures: number;
	sourceCoverage: number;
	sourcePresenceRate: number | null;
	citationRate: number | null;
	sourceToCitationRate: number | null;
	averageMentionPosition: number | null;
	competitorMentionRates: Record<string, number>;
};

export type OverallVisibilityMetrics = {
	answerCoverage: number;
	brandMentionRate: number;
	firstRecommendationRate: number;
	brandShareOfVoice: number;
	repeatConsistency: number | null;
	citationRate: number | null;
	averageMentionPosition: number | null;
	plannedPlatformCount: number;
	validPlatformCount: number;
	failedPlatformCount: number;
	dataCoverage: number;
	failureRate: number;
};

const ratio = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

const normalizeDomain = (domain: string): string =>
	domain
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");

export function calculateVisibilityMetrics({
	captures,
	targetBrandId,
	targetDomains,
	competitorBrandIds = [],
}: VisibilityMetricInput): VisibilityMetrics {
	const answered = captures.filter((capture) => capture.status === "complete" && capture.answerText !== null);
	const sourceObserved = answered.filter(
		(capture) => capture.captureMode === "consumer_surface" || capture.sourceVisibility !== "unavailable",
	);
	const normalizedDomains = new Set(targetDomains.map(normalizeDomain));
	const hasTargetBrand = (capture: QueryCapture) =>
		capture.brandMatches.some((match) => match.brandId === targetBrandId);
	const hasTargetSource = (capture: QueryCapture) =>
		capture.sources.some((source) => normalizedDomains.has(normalizeDomain(source.domain)));
	const hasTargetCitation = (capture: QueryCapture) =>
		capture.sources.some((source) => source.isCitation && normalizedDomains.has(normalizeDomain(source.domain)));

	const mentioned = answered.filter(hasTargetBrand);
	const firstRecommended = answered.filter((capture) =>
		capture.brandMatches.some((match) => match.brandId === targetBrandId && match.position === 1),
	);
	const inSources = sourceObserved.filter(hasTargetSource);
	const cited = sourceObserved.filter(hasTargetCitation);
	const mentionPositions = mentioned.flatMap((capture) =>
		capture.brandMatches.filter((match) => match.brandId === targetBrandId).map((match) => match.position),
	);
	const targetMentions = answered.reduce(
		(count, capture) => count + capture.brandMatches.filter((match) => match.brandId === targetBrandId).length,
		0,
	);
	const monitoredBrandIds = new Set([targetBrandId, ...competitorBrandIds]);
	const monitoredMentions = answered.reduce(
		(count, capture) => count + capture.brandMatches.filter((match) => monitoredBrandIds.has(match.brandId)).length,
		0,
	);
	const promptOutcomes = new Map<string, QueryCapture[]>();
	for (const capture of answered) {
		const group = promptOutcomes.get(capture.promptId) ?? [];
		group.push(capture);
		promptOutcomes.set(capture.promptId, group);
	}
	const repeatScores = [...promptOutcomes.values()]
		.filter((group) => group.length > 1)
		.map((group) => {
			const mentions = group.filter(hasTargetBrand).length;
			return Math.max(mentions, group.length - mentions) / group.length;
		});

	return {
		totalCaptures: captures.length,
		answeredCaptures: answered.length,
		answerCoverage: ratio(answered.length, captures.length),
		brandMentionRate: ratio(mentioned.length, answered.length),
		firstRecommendationRate: ratio(firstRecommended.length, answered.length),
		brandShareOfVoice: ratio(targetMentions, monitoredMentions),
		repeatConsistency:
			repeatScores.length === 0 ? null : repeatScores.reduce((sum, score) => sum + score, 0) / repeatScores.length,
		sourceObservedCaptures: sourceObserved.length,
		sourceCoverage: ratio(sourceObserved.length, answered.length),
		sourcePresenceRate: sourceObserved.length === 0 ? null : ratio(inSources.length, sourceObserved.length),
		citationRate: sourceObserved.length === 0 ? null : ratio(cited.length, sourceObserved.length),
		sourceToCitationRate: inSources.length === 0 ? null : ratio(cited.length, inSources.length),
		averageMentionPosition:
			mentionPositions.length === 0
				? null
				: mentionPositions.reduce((sum, position) => sum + position, 0) / mentionPositions.length,
		competitorMentionRates: Object.fromEntries(
			competitorBrandIds.map((brandId) => [
				brandId,
				ratio(
					answered.filter((capture) => capture.brandMatches.some((match) => match.brandId === brandId)).length,
					answered.length,
				),
			]),
		),
	};
}

export function calculateEqualWeightedOverall(platforms: VisibilityMetrics[]): OverallVisibilityMetrics {
	const validPlatforms = platforms.filter((metrics) => metrics.answeredCaptures > 0);
	const average = (key: keyof VisibilityMetrics, source = validPlatforms): number | null => {
		const values = source.map((metrics) => metrics[key]).filter((value): value is number => typeof value === "number");
		return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	};
	const plannedPlatformCount = platforms.length;
	const validPlatformCount = validPlatforms.length;
	return {
		answerCoverage: average("answerCoverage", platforms) ?? 0,
		brandMentionRate: average("brandMentionRate") ?? 0,
		firstRecommendationRate: average("firstRecommendationRate") ?? 0,
		brandShareOfVoice: average("brandShareOfVoice") ?? 0,
		repeatConsistency: average("repeatConsistency"),
		citationRate: average("citationRate"),
		averageMentionPosition: average("averageMentionPosition"),
		plannedPlatformCount,
		validPlatformCount,
		failedPlatformCount: plannedPlatformCount - validPlatformCount,
		dataCoverage: ratio(validPlatformCount, plannedPlatformCount),
		failureRate: ratio(plannedPlatformCount - validPlatformCount, plannedPlatformCount),
	};
}
