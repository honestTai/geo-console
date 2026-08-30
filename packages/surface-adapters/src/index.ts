import type { CaptureFailureCode, CitationSource, EngineSurface } from "@geo/evidence";
import type { BrowserContext, Page } from "playwright";

export { classifySessionText } from "./status";

export const currentCollectorVersion = "0.1.3";

export type SessionState = "ready" | "login_required" | "challenge_required";

export type ExtractedAnswer = {
	answerText: string;
	sources: CitationSource[];
	queryFanOut: string[];
	pageUrl: string;
};

export class CaptureAdapterError extends Error {
	constructor(
		public readonly code: CaptureFailureCode,
		message: string,
	) {
		super(message);
	}
}

export interface CaptureAdapter {
	readonly id: EngineSurface;
	readonly displayName: string;
	readonly consumerUrl: string;
	readonly version: string;
	checkSession(page: Page): Promise<SessionState>;
	openLogin(context: BrowserContext): Promise<void>;
	startConversation(page: Page): Promise<void>;
	submitQuestion(page: Page, question: string): Promise<void>;
	waitForAnswer(page: Page, timeoutMs: number): Promise<void>;
	extractAnswer(page: Page): Promise<ExtractedAnswer>;
}

export type SurfaceAdapterManifest = {
	id: EngineSurface;
	displayName: string;
	consumerUrl: string;
	authMode: "local_browser_profile";
	supportsSources: boolean;
};

export const surfaceAdapterManifests: readonly SurfaceAdapterManifest[] = [
	{
		id: "deepseek",
		displayName: "DeepSeek",
		consumerUrl: "https://chat.deepseek.com/",
		authMode: "local_browser_profile",
		supportsSources: true,
	},
	{
		id: "kimi",
		displayName: "Kimi",
		consumerUrl: "https://www.kimi.com/",
		authMode: "local_browser_profile",
		supportsSources: true,
	},
];

export function getSurfaceAdapterManifest(engine: EngineSurface): SurfaceAdapterManifest {
	const manifest = surfaceAdapterManifests.find((item) => item.id === engine);
	if (!manifest) throw new Error(`未注册的真实页面适配器：${engine}`);
	return manifest;
}
