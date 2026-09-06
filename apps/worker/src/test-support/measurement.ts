/** Explicit test doubles for workflow tests. Never imported by production modules. */
import { randomUUID } from "node:crypto";
import type { Database, FrozenBatchConfig } from "@geo/core";
import type { FrozenMeasurementContract } from "@geo/evidence";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { pendingMetrics } from "../measurement";
import { sha256, stableJson } from "../utils";

export const testMeasurementContract: FrozenMeasurementContract = {
	contractVersion: "geo.visibility-measurement.v2",
	sampling: {
		mode: "quick",
		repeats: 1,
		executionWindows: ["PT0M"],
		minimumSuccessfulRepeatsPerPrompt: 1,
		minimumPromptCoverage: 0.8,
	},
	semantic: {
		schemaVersion: "geo.semantic-observation.v1",
		promptVersion: "semantic.atomic.v1",
		modelProvider: "hrouter",
		modelId: "gpt-test",
		modelRevision: null,
		endpoint: "https://example.com/v1",
		validatorVersion: "semantic.evidence.v1",
		adjudicationPolicyVersion: "independent-agreement.v1",
	},
	metrics: {
		algorithmVersion: "visibility.prompt-weighted.v2",
		intervalMethod: "cluster-bootstrap-percentile",
		bootstrapIterations: 2000,
		bootstrapSeed: "test-seed",
		minimumEligiblePrompts: 10,
		minimumParseCoverage: 0.9,
		maximumIntervalWidth: 0.5,
		reportabilityPolicyVersion: "coverage-gates.v1",
		driftPolicyVersion: "paired-delta95.v1",
	},
	surfaces: { api: { enabled: true }, consumerApp: { enabled: false, contractVersion: null } },
};

export async function seedMeasurementModel(database: Database): Promise<void> {
	await database.query(
		`INSERT INTO settings(key,value) VALUES('organization:default:hrouter_config','{"model":"gpt-test","baseUrl":"https://example.com/v1"}'::jsonb) ON CONFLICT DO NOTHING`,
	);
}

export async function seedMetricSnapshot(database: Database, batchId: string): Promise<string> {
	const row = (
		await database.query<{ config: FrozenBatchConfig; project_id: string; organization_id: string }>(
			`SELECT b.config,b.project_id,p.organization_id FROM experiment_batches b JOIN projects p ON p.id=b.project_id WHERE b.id=$1`,
			[batchId],
		)
	).rows[0];
	if (!row) throw new Error("Test batch missing");
	const id = randomUUID(),
		runId = randomUUID();
	const config = Object.assign(
		{
			project: { name: "测试客户", domain: "example.com", region: "CN", language: "zh-CN", aliases: [] },
			competitors: [],
			prompts: [],
			platforms: [],
			repeats: 1,
		},
		row.config,
	) as FrozenBatchConfig;
	if (!config.providers?.length)
		config.providers = [
			{
				id: "qwen_api",
				endpoint: "https://provider.example/v1",
				adapterVersion: ADAPTER_VERSION,
				model: "test",
				protocol: "test",
				searchToolVersion: "test",
				searchStrategy: {},
			},
		];
	config.providers = config.providers.map((provider) => ({
		...provider,
		endpoint: provider.endpoint ?? "https://provider.example/v1",
		adapterVersion: provider.adapterVersion ?? ADAPTER_VERSION,
	}));
	config.measurement = config.measurement ?? testMeasurementContract;
	await database.query("UPDATE experiment_batches SET config=$2::jsonb WHERE id=$1", [batchId, JSON.stringify(config)]);
	const contract = config.measurement ?? testMeasurementContract;
	const payload = { ...pendingMetrics(config, []), contract, configHash: sha256(stableJson(config)) };
	payload.overall.status = "ready";
	await database.query(
		`INSERT INTO semantic_parse_runs(id,organization_id,project_id,batch_id,contract,contract_hash,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,'ready')`,
		[runId, row.organization_id, row.project_id, batchId, JSON.stringify(contract), sha256(stableJson(contract))],
	);
	await database.query(
		`INSERT INTO metric_snapshots(id,run_id,batch_id,algorithm_version,contract_hash,input_hash,payload,payload_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'ready')`,
		[
			id,
			runId,
			batchId,
			contract.metrics.algorithmVersion,
			sha256(stableJson(contract)),
			id,
			JSON.stringify(payload),
			sha256(stableJson(payload)),
		],
	);
	await database.query("UPDATE semantic_parse_runs SET current_metric_id=$2 WHERE id=$1", [runId, id]);
	await database.query("UPDATE agent_runs SET metric_snapshot_id=$2 WHERE batch_id=$1", [batchId, id]);
	return id;
}
