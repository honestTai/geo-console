-- Cloud monitoring is a new evidence protocol. Existing consumer-surface rows remain unchanged.
ALTER TYPE batch_kind ADD VALUE IF NOT EXISTS 'quick_audit';
ALTER TYPE capture_status ADD VALUE IF NOT EXISTS 'auth_required';
ALTER TYPE capture_status ADD VALUE IF NOT EXISTS 'search_not_triggered';
ALTER TYPE capture_status ADD VALUE IF NOT EXISTS 'model_unavailable';
ALTER TYPE capture_status ADD VALUE IF NOT EXISTS 'protocol_changed';

ALTER TABLE query_captures ALTER COLUMN platform TYPE text USING platform::text;
ALTER TABLE query_captures ALTER COLUMN page_url DROP NOT NULL;
ALTER TABLE query_captures ALTER COLUMN collector_node_id DROP NOT NULL;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT 'geo.query-capture.v1';
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'consumer_surface';
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS protocol text;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS search_tool_version text;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS source_visibility text NOT NULL DEFAULT 'available';
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS fanout_visibility text NOT NULL DEFAULT 'available';
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS raw_artifact_key text;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS cost_micros bigint;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE query_captures ADD COLUMN IF NOT EXISTS executor_id text;

ALTER TABLE monitoring_schedules ALTER COLUMN platforms TYPE jsonb USING platforms::jsonb;
ALTER TABLE monitoring_schedules ADD COLUMN IF NOT EXISTS sampling_mode text NOT NULL DEFAULT 'formal';
ALTER TABLE monitoring_schedules ADD COLUMN IF NOT EXISTS execution_windows jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organizations (id, name) VALUES ('default', '默认机构') ON CONFLICT (id) DO NOTHING;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS projects_organization_idx ON projects(organization_id, created_at);

CREATE TABLE IF NOT EXISTS provider_configs (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL,
  endpoint text NOT NULL,
  protocol text NOT NULL,
  search_strategy jsonb NOT NULL DEFAULT '{}',
  adapter_version text NOT NULL,
  last_test_status text,
  last_test_message text,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, provider_id)
);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  credential_key text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, credential_key)
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  password_hash text NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_lookup_idx ON sessions(token_hash, expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_organization_idx ON audit_logs(organization_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  tool_trace jsonb NOT NULL DEFAULT '[]',
  usage jsonb,
  cost_micros bigint,
  draft jsonb,
  error_message text,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON agent_runs(project_id, created_at);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  compare_to_batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  report_type text NOT NULL CHECK (report_type IN ('quick_audit', 'remediation', 'retest')),
  schema_version text NOT NULL,
  title text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  pdf_artifact_key text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_snapshots_project_idx ON report_snapshots(project_id, created_at);

CREATE TABLE IF NOT EXISTS report_shares (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES report_snapshots(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drift_alerts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text NOT NULL REFERENCES experiment_batches(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  metric text NOT NULL,
  previous_value real,
  current_value real,
  severity text NOT NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]',
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drift_alerts_project_idx ON drift_alerts(project_id, created_at);

CREATE TABLE IF NOT EXISTS project_costs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  provider_id text NOT NULL,
  operation text NOT NULL,
  usage jsonb,
  cost_micros bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_costs_project_idx ON project_costs(project_id, occurred_at);
