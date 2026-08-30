import type { BrandMatch, CaptureFailureCode, CaptureStatus, CitationSource, SearchProvider } from "@geo/evidence";

export type ProviderCapabilities = {
	forcedSearch: boolean;
	sources: "available" | "partial" | "unavailable";
	queryFanOut: "available" | "partial" | "unavailable";
	compositeSurface: boolean;
	consumerAppEquivalent: false;
};

export type ConnectionResult = {
	ok: boolean;
	status: "connected" | "auth_required" | "rate_limited" | "unavailable" | "invalid_configuration";
	message: string;
	latencyMs: number;
};

export type CaptureBrand = { id: string; name: string; aliases: string[] };

export type CaptureInput = {
	prompt: string;
	region: string;
	locale: string;
	brands: CaptureBrand[];
	signal?: AbortSignal;
};

export type ProviderUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	searchRequests?: number;
};

export type ProviderCaptureResult = {
	providerId: SearchProvider;
	status: CaptureStatus;
	answerText: string | null;
	brandMatches: BrandMatch[];
	sources: CitationSource[];
	queryFanOut: string[];
	sourceVisibility: "available" | "partial" | "unavailable";
	fanoutVisibility: "available" | "partial" | "unavailable";
	model: string;
	protocol: string;
	searchToolVersion: string;
	adapterVersion: string;
	requestId: string | null;
	usage: ProviderUsage | null;
	costMicros: number | null;
	latencyMs: number;
	rawResponse: unknown;
	failureCode: CaptureFailureCode | null;
	failureMessage: string | null;
};

export type ProviderConfig = {
	providerId: SearchProvider;
	endpoint: string;
	model: string;
	protocol: string;
	searchToolVersion: string;
	apiKey: string;
	secondaryEndpoint?: string;
	secondaryApiKey?: string;
	options?: Record<string, unknown>;
};

export interface SearchProviderAdapter {
	readonly id: SearchProvider;
	testConnection(): Promise<ConnectionResult>;
	capabilities(): ProviderCapabilities;
	capture(input: CaptureInput): Promise<ProviderCaptureResult>;
}

export type AdapterDependencies = {
	fetch: typeof globalThis.fetch;
	now: () => number;
};
