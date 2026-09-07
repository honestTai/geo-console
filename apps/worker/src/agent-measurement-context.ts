import type { Database, FrozenBatchConfig } from "@geo/core";
import { type ExplainableMetrics, explainMeasurement } from "@geo/metrics";
import { captureFromRow } from "./service";
import { parseJsonColumn } from "./utils";

/** Read the run-bound metric, never the latest metric or current edited question text. No model calls. */
export async function readAgentMeasurementContext(
	database: Database,
	projectId: string,
	batchId: string | null,
	runId: string | null,
) {
	if (!batchId || !runId) return { metricSnapshot: null, frozenBatchConfig: null, readerGuide: null };
	const row = (
		await database.query<{
			id: string;
			payload: unknown;
			payload_hash: string;
			config: unknown;
			paired_comparison: unknown;
		}>(
			`SELECT m.id,m.payload,m.payload_hash,b.config,
		 COALESCE((SELECT jsonb_agg(jsonb_build_object('platform',d.provider_id,'metric',d.metric,'result',d.result,'baselineSnapshotId',d.baseline_metric_id))
		 FROM measurement_drift_observations d WHERE d.metric_id=m.id AND d.baseline_metric_id=r.baseline_metric_snapshot_id),'[]'::jsonb) AS paired_comparison
		 FROM agent_runs r JOIN metric_snapshots m ON m.id=r.metric_snapshot_id AND m.batch_id=r.batch_id
		 JOIN experiment_batches b ON b.id=r.batch_id AND b.project_id=r.project_id
		 WHERE r.id=$1 AND r.project_id=$2 AND r.batch_id=$3`,
			[runId, projectId, batchId],
		)
	).rows[0];
	if (!row) return { metricSnapshot: null, frozenBatchConfig: null, readerGuide: null };
	const config = parseJsonColumn<FrozenBatchConfig>(row.config as string | FrozenBatchConfig);
	const payload = parseJsonColumn<ExplainableMetrics>(row.payload as string | ExplainableMetrics);
	const questions = new Map(config.prompts.map((p) => [p.id, p.question]));
	const raw = await database.query<Record<string, unknown>>(
		"SELECT * FROM query_captures WHERE project_id=$1 AND batch_id=$2 ORDER BY captured_at",
		[projectId, batchId],
	);
	const captures = raw.rows.map((c) =>
		captureFromRow({
			...c,
			question: questions.get(String(c.prompt_id)) ?? "历史未保存问题",
			region: config.project.region,
			language: config.project.language,
		}),
	);
	return {
		metricSnapshot: {
			id: row.id,
			payload,
			payload_hash: row.payload_hash,
			paired_comparison: parseJsonColumn(row.paired_comparison as string | unknown[]),
		},
		frozenBatchConfig: config,
		readerGuide: explainMeasurement(payload, config, captures),
	};
}
