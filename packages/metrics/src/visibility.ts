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
	sourcePresenceRate: number;
	citationRate: number;
	sourceToCitationRate: number | null;
	averageMentionPosition: number | null;
	competitorMentionRates: Record<string, number>;
};

export type OverallVisibilityMetrics = Pick<
	VisibilityMetrics,
	"answerCoverage" | "brandMentionRate" | "firstRecommendationRate" | "citationRate" | "averageMentionPosition"
>;

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
	const inSources = answered.filter(hasTargetSource);
	const cited = answered.filter(hasTargetCitation);
	const mentionPositions = mentioned.flatMap((capture) =>
		capture.brandMatches.filter((match) => match.brandId === targetBrandId).map((match) => match.position),
	);

	return {
		totalCaptures: captures.length,
		answeredCaptures: answered.length,
		answerCoverage: ratio(answered.length, captures.length),
		brandMentionRate: ratio(mentioned.length, answered.length),
		firstRecommendationRate: ratio(firstRecommended.length, answered.length),
		sourcePresenceRate: ratio(inSources.length, answered.length),
		citationRate: ratio(cited.length, answered.length),
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
	const keys: Array<keyof OverallVisibilityMetrics> = [
		"answerCoverage",
		"brandMentionRate",
		"firstRecommendationRate",
		"citationRate",
		"averageMentionPosition",
	];
	return Object.fromEntries(
		keys.map((key) => {
			const values = platforms
				.map((metrics) => metrics[key])
				.filter((value): value is number => typeof value === "number");
			return [
				key,
				values.length
					? values.reduce((sum, value) => sum + value, 0) / values.length
					: key === "averageMentionPosition"
						? null
						: 0,
			];
		}),
	) as OverallVisibilityMetrics;
}
