CREATE TABLE semantic_parse_runs (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), project_id text NOT NULL REFERENCES projects(id),
 batch_id text NOT NULL REFERENCES experiment_batches(id), contract jsonb NOT NULL, contract_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','partial','failed')),
 current_metric_id text, error_message text, created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
ALTER TABLE agent_sessions ADD COLUMN cancelled_at timestamptz;
CREATE INDEX semantic_runs_batch_idx ON semantic_parse_runs(batch_id,created_at DESC);
CREATE TABLE semantic_observations (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES semantic_parse_runs(id), capture_id text NOT NULL REFERENCES query_captures(id),
 contract_hash text NOT NULL, pass_kind text NOT NULL CHECK (pass_kind IN ('primary','review','human')),
 status text NOT NULL CHECK (status IN ('valid','needs_review','failed')), observation jsonb, validation jsonb NOT NULL,
 raw_artifact_key text, usage jsonb, cost_micros bigint, reviewed_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX semantic_observations_capture_idx ON semantic_observations(run_id,capture_id);
CREATE TABLE semantic_selections (
 run_id text NOT NULL REFERENCES semantic_parse_runs(id), capture_id text NOT NULL REFERENCES query_captures(id),
 observation_id text NOT NULL REFERENCES semantic_observations(id), PRIMARY KEY(run_id,capture_id)
);
CREATE TABLE metric_snapshots (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES semantic_parse_runs(id), batch_id text NOT NULL REFERENCES experiment_batches(id),
 algorithm_version text NOT NULL, contract_hash text NOT NULL, input_hash text NOT NULL,
 payload jsonb NOT NULL, payload_hash text NOT NULL, status text NOT NULL CHECK (status IN ('ready','limited','unavailable')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,input_hash)
);
ALTER TABLE semantic_parse_runs ADD CONSTRAINT semantic_current_metric_fk FOREIGN KEY(current_metric_id) REFERENCES metric_snapshots(id);
CREATE UNIQUE INDEX semantic_job_key ON jobs ((payload->>'runId'),(payload->>'captureId')) WHERE type='semantic_parse';
CREATE TABLE measurement_drift_observations (
 id text PRIMARY KEY, baseline_metric_id text NOT NULL REFERENCES metric_snapshots(id), metric_id text NOT NULL REFERENCES metric_snapshots(id),
 provider_id text NOT NULL, metric text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(baseline_metric_id,metric_id,provider_id,metric)
);
ALTER TABLE agent_runs ADD COLUMN metric_snapshot_id text REFERENCES metric_snapshots(id);
ALTER TABLE agent_runs ADD COLUMN baseline_metric_snapshot_id text REFERENCES metric_snapshots(id);
ALTER TABLE query_captures ADD COLUMN sample_key text;
CREATE UNIQUE INDEX capture_sample_key_idx ON query_captures(sample_key) WHERE sample_key IS NOT NULL;
ALTER TABLE drift_alerts ADD COLUMN metric_snapshot_id text REFERENCES metric_snapshots(id);
ALTER TABLE drift_alerts ADD COLUMN baseline_metric_snapshot_id text REFERENCES metric_snapshots(id);
ALTER TABLE diagnosis_findings ADD COLUMN metric_snapshot_id text REFERENCES metric_snapshots(id);
ALTER TABLE remediation_tasks ADD COLUMN metric_snapshot_id text REFERENCES metric_snapshots(id);
INSERT INTO permission_routes(id,permission_key,http_method,path_pattern,position) VALUES
 ('route-measurement-reparse','agent.run','POST','/api/batches/:batchId/measurement',30),
 ('route-measurement-observations','page.evidence','GET','/api/batches/:batchId/measurement',30),
 ('route-measurement-review','agent.approve','POST','/api/batches/:batchId/measurement/review',30);
