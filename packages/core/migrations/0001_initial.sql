DO $$ BEGIN CREATE TYPE project_status AS ENUM ('draft', 'review', 'active', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE platform AS ENUM ('deepseek', 'kimi'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE batch_kind AS ENUM ('baseline', 'retest'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE batch_status AS ENUM ('draft', 'queued', 'running', 'complete', 'partial'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_status AS ENUM ('pending', 'leased', 'complete', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE capture_status AS ENUM ('complete', 'no_answer', 'login_required', 'challenge_required', 'rate_limited', 'page_contract_changed', 'timeout', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY, name text NOT NULL, website_url text NOT NULL, domain text NOT NULL UNIQUE,
  region text NOT NULL, language text NOT NULL, business_focus text, aliases jsonb NOT NULL DEFAULT '[]',
  profile jsonb, status project_status NOT NULL DEFAULT 'draft', confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS competitors (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name text NOT NULL,
  domain text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]', approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, domain)
);
CREATE TABLE IF NOT EXISTS prompts (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, question text NOT NULL,
  intent text NOT NULL, tags jsonb NOT NULL DEFAULT '[]', approved boolean NOT NULL DEFAULT false,
  position integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prompts_project_idx ON prompts(project_id);
CREATE TABLE IF NOT EXISTS website_snapshots (
  id text PRIMARY KEY, project_id text REFERENCES projects(id) ON DELETE CASCADE, url text NOT NULL, domain text NOT NULL,
  title text, content_text text NOT NULL, structured_data jsonb NOT NULL DEFAULT '[]', content_hash text NOT NULL,
  artifact_key text, fetched_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS website_snapshots_project_idx ON website_snapshots(project_id);
CREATE TABLE IF NOT EXISTS experiment_batches (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind batch_kind NOT NULL,
  compare_to_batch_id text, status batch_status NOT NULL DEFAULT 'draft', config jsonb NOT NULL, config_hash text NOT NULL,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_project_idx ON experiment_batches(project_id);
CREATE TABLE IF NOT EXISTS collector_nodes (
  id text PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL, version text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]', last_seen_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, status job_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3, available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text, lease_expires_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, available_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS query_captures (
  id text PRIMARY KEY, job_id text NOT NULL UNIQUE REFERENCES jobs(id), batch_id text NOT NULL REFERENCES experiment_batches(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, prompt_id text NOT NULL REFERENCES prompts(id),
  platform platform NOT NULL, attempt integer NOT NULL, status capture_status NOT NULL, answer_text text,
  brand_matches jsonb NOT NULL DEFAULT '[]', sources jsonb NOT NULL DEFAULT '[]', query_fan_out jsonb NOT NULL DEFAULT '[]',
  page_url text NOT NULL, screenshot_key text, trace_key text, content_hash text, adapter_version text NOT NULL,
  collector_node_id text NOT NULL, failure_code text, failure_message text, captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS captures_batch_platform_idx ON query_captures(batch_id, platform);
CREATE TABLE IF NOT EXISTS diagnosis_findings (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text NOT NULL REFERENCES experiment_batches(id) ON DELETE CASCADE, category text NOT NULL,
  title text NOT NULL, detail text NOT NULL, confidence real NOT NULL, evidence_ids jsonb NOT NULL,
  recommendation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_batch_idx ON diagnosis_findings(batch_id);
CREATE TABLE IF NOT EXISTS remediation_tasks (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finding_id text REFERENCES diagnosis_findings(id) ON DELETE SET NULL, title text NOT NULL, detail text NOT NULL,
  priority text NOT NULL, status text NOT NULL DEFAULT 'todo', owner text, due_date timestamptz,
  target_prompt_ids jsonb NOT NULL DEFAULT '[]', evidence_ids jsonb NOT NULL DEFAULT '[]', expected_metric text NOT NULL,
  acceptance_criteria text NOT NULL, content_brief text, draft_content text, published_url text,
  verified_snapshot_id text REFERENCES website_snapshots(id), completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON remediation_tasks(project_id);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
