export { ADAPTER_VERSION, matchBrands, ProviderRequestError } from "./common";
export { DeepSeekSearchAdapter } from "./deepseek";
export { DoubaoSearchAdapter } from "./doubao";
export { KimiSearchAdapter } from "./kimi";
export { QwenSearchAdapter } from "./qwen";
export type {
	AdapterDependencies,
	CaptureBrand,
	CaptureInput,
	ConnectionResult,
	ProviderCapabilities,
	ProviderCaptureResult,
	ProviderConfig,
	ProviderUsage,
	SearchProviderAdapter,
} from "./types";
export { YuanbaoHunyuanSearchAdapter } from "./yuanbao";

import { DeepSeekSearchAdapter } from "./deepseek";
import { DoubaoSearchAdapter } from "./doubao";
import { KimiSearchAdapter } from "./kimi";
import { QwenSearchAdapter } from "./qwen";
import type { AdapterDependencies, ProviderConfig, SearchProviderAdapter } from "./types";
import { YuanbaoHunyuanSearchAdapter } from "./yuanbao";

export function createSearchProviderAdapter(
	config: ProviderConfig,
	dependencies?: AdapterDependencies,
): SearchProviderAdapter {
	switch (config.providerId) {
		case "deepseek_api":
			return new DeepSeekSearchAdapter(config, dependencies);
		case "kimi_api":
			return new KimiSearchAdapter(config, dependencies);
		case "doubao_api":
			return new DoubaoSearchAdapter(config, dependencies);
		case "qwen_api":
			return new QwenSearchAdapter(config, dependencies);
		case "yuanbao_hunyuan":
			return new YuanbaoHunyuanSearchAdapter(config, dependencies);
	}
}
