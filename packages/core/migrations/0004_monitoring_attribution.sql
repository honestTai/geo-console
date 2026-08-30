CREATE TABLE IF NOT EXISTS monitoring_schedules (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  frequency_days integer NOT NULL DEFAULT 7,
  platforms jsonb NOT NULL DEFAULT '[]',
  repeats integer NOT NULL DEFAULT 3,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id)
);
CREATE INDEX IF NOT EXISTS monitoring_schedules_due_idx ON monitoring_schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS attribution_imports (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  file_name text NOT NULL,
  row_count integer NOT NULL,
  content_hash text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, content_hash)
);
CREATE INDEX IF NOT EXISTS attribution_imports_project_idx ON attribution_imports(project_id, imported_at);

CREATE TABLE IF NOT EXISTS attribution_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id text NOT NULL REFERENCES attribution_imports(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  metric text NOT NULL,
  value real NOT NULL,
  observed_at timestamptz NOT NULL,
  landing_url text,
  external_id text,
  channel text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attribution_events_project_date_idx ON attribution_events(project_id, observed_at);
