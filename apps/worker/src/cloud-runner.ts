import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	claimCaptureJob,
	type Database,
	type FrozenBatchConfig,
	renewJobLease,
	type SearchProviderId,
	searchProviderIds,
} from "@geo/core";
import { ADAPTER_VERSION, type ProviderCaptureResult } from "@geo/search-providers";
import { putArtifact } from "./object-store";
import { buildProviderAdapter, providerDefinitions } from "./providers";
import { storeCloudCapture } from "./service";
import { parseJsonColumn, sha256, stableJson } from "./utils";

type FrozenProvider = NonNullable<FrozenBatchConfig["providers"]>[number];

export function frozenProviderContract(config: FrozenBatchConfig, providerId: SearchProviderId): FrozenProvider | null {
	return config.providers?.find((provider) => provider.id === providerId) ?? null;
}

const executorId = process.env.GEO_EXECUTOR_ID?.trim() || `cloud-worker:${process.pid}:${randomUUID()}`;

async function persistRawResponse(projectId: string, captureId: string, payload: unknown): Promise<string> {
	const objectKey = join("captures", projectId, `${captureId}.json`);
	return putArtifact(objectKey, stableJson(payload), "application/json; charset=utf-8");
}

function configurationFailure(
	providerId: SearchProviderId,
	message: string,
	frozen?: FrozenProvider,
	contractFailure = false,
): ProviderCaptureResult {
	const definition = providerDefinitions[providerId];
	return {
		providerId,
		status: contractFailure ? "protocol_changed" : "auth_required",
		answerText: null,
		brandMatches: [],
		sources: [],
		queryFanOut: [],
		sourceVisibility: "unavailable",
		fanoutVisibility: "unavailable",
		model: frozen?.model ?? definition.model,
		protocol: frozen?.protocol ?? definition.protocol,
		searchToolVersion: frozen?.searchToolVersion ?? definition.searchToolVersion,
		adapterVersion: frozen?.adapterVersion ?? ADAPTER_VERSION,
		requestId: null,
		usage: null,
		costMicros: null,
		latencyMs: 0,
		rawResponse: { error: message },
		failureCode: contractFailure ? "protocol_changed" : "authentication_failed",
		failureMessage: message,
	};
}

export async function runOneCloudCapture(database: Database): Promise<boolean> {
	const job = await claimCaptureJob(database, executorId, 300, [...searchProviderIds]);
	if (!job) return false;
	const providerId = job.payload.platform as SearchProviderId;
	const captureId = randomUUID();
	const renewTimer = setInterval(() => {
		renewJobLease(database, job.id, executorId, 300).catch((error) =>
			console.error("云端采集租约续期失败", job.id, error),
		);
	}, 60_000);
	renewTimer.unref();
	try {
		let result: ProviderCaptureResult;
		const batchRow = (
			await database.query<{ config: FrozenBatchConfig | string }>(
				"SELECT config FROM experiment_batches WHERE id=$1 AND project_id=$2",
				[job.payload.batchId, job.payload.projectId],
			)
		).rows[0];
		const frozen = batchRow
			? frozenProviderContract(parseJsonColumn<FrozenBatchConfig>(batchRow.config), providerId)
			: null;
		if (!frozen?.endpoint || !frozen.adapterVersion) {
			result = configurationFailure(
				providerId,
				"批次缺少完整的冻结 Provider 契约，请创建新的正式基线",
				frozen ?? undefined,
				true,
			);
		} else if (frozen.adapterVersion !== ADAPTER_VERSION) {
			result = configurationFailure(
				providerId,
				`批次要求适配器 ${frozen.adapterVersion}，当前 Worker 仅支持 ${ADAPTER_VERSION}`,
				frozen,
				true,
			);
		} else {
			try {
				const adapter = await buildProviderAdapter(database, providerId, {
					endpoint: frozen.endpoint,
					secondaryEndpoint: frozen.secondaryEndpoint,
					model: frozen.model,
					protocol: frozen.protocol,
					searchToolVersion: frozen.searchToolVersion,
					searchStrategy: frozen.searchStrategy,
				});
				result = await adapter.capture({
					prompt: job.payload.prompt,
					region: job.payload.region,
					locale: job.payload.locale,
					brands: job.payload.brands,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "平台配置不可用";
				if (!/密钥|尚未配置|GEO_MASTER_KEY|主密钥/.test(message)) throw error;
				result = configurationFailure(providerId, message, frozen);
			}
		}
		const rawResponseObjectKey = await persistRawResponse(job.payload.projectId, captureId, {
			schemaVersion: "geo.provider-raw.v1",
			providerId,
			jobId: job.id,
			capturedAt: new Date().toISOString(),
			response: result.rawResponse,
		});
		await storeCloudCapture(database, {
			schemaVersion: "geo.query-capture.v2",
			captureId,
			jobId: job.id,
			projectId: job.payload.projectId,
			promptId: job.payload.promptId,
			prompt: job.payload.prompt,
			engine: providerId,
			captureMode: "llm_search_api",
			attempt: job.payload.attempt,
			capturedAt: new Date().toISOString(),
			locale: job.payload.locale,
			region: job.payload.region,
			status: result.status,
			answerText: result.answerText,
			brandMatches: result.brandMatches,
			sources: result.sources,
			queryFanOut: result.queryFanOut,
			sourceVisibility: result.sourceVisibility,
			fanoutVisibility: result.fanoutVisibility,
			evidence: {
				endpoint: frozen?.endpoint ?? providerDefinitions[providerId].endpoint,
				rawResponseObjectKey,
				requestId: result.requestId,
			},
			model: result.model,
			protocol: result.protocol,
			searchToolVersion: result.searchToolVersion,
			adapterVersion: result.adapterVersion,
			executorId,
			usage: result.usage,
			costMicros: result.costMicros,
			latencyMs: result.latencyMs,
			contentHash: result.answerText ? sha256(result.answerText) : null,
			failureCode: result.failureCode,
			failureMessage: result.failureMessage,
		});
		return true;
	} finally {
		clearInterval(renewTimer);
	}
}

export function startCloudRunner(database: Database): () => void {
	const concurrency = Math.max(1, Math.min(20, Number(process.env.GEO_CAPTURE_CONCURRENCY || 2)));
	let active = 0;
	let stopped = false;
	const tick = (): void => {
		while (!stopped && active < concurrency) {
			active += 1;
			runOneCloudCapture(database)
				.catch((error) => console.error("云端采集执行失败", error))
				.finally(() => {
					active -= 1;
				});
		}
	};
	const timer = setInterval(tick, 1_000);
	tick();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
