CREATE TABLE IF NOT EXISTS website_audits (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_url text NOT NULL,
  result jsonb NOT NULL,
  result_hash text NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS website_audits_project_idx ON website_audits(project_id, checked_at);
