ALTER TABLE competitors ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE prompts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE competitors DROP CONSTRAINT IF EXISTS competitors_project_id_domain_key;
DROP INDEX IF EXISTS competitors_project_domain_unique;
CREATE UNIQUE INDEX IF NOT EXISTS competitors_active_project_domain_unique
  ON competitors(project_id, domain) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS competitors_active_project_idx ON competitors(project_id, archived_at);
CREATE INDEX IF NOT EXISTS prompts_active_project_idx ON prompts(project_id, archived_at, position);
