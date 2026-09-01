CREATE TABLE IF NOT EXISTS service_logs (
  id text PRIMARY KEY,
  organization_id text,
  service text NOT NULL,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event text NOT NULL,
  message text NOT NULL,
  trace_id text,
  project_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_logs_organization_time_idx
  ON service_logs(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS service_logs_service_level_time_idx
  ON service_logs(service, level, occurred_at DESC);
CREATE INDEX IF NOT EXISTS service_logs_trace_idx ON service_logs(trace_id);
