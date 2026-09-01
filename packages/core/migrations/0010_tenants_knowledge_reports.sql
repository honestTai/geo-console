ALTER TABLE projects ADD COLUMN IF NOT EXISTS industry text;

CREATE TABLE IF NOT EXISTS prompt_library_questions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  industry text NOT NULL,
  question text NOT NULL,
  intent text NOT NULL,
  topic text,
  persona text,
  tags jsonb NOT NULL DEFAULT '[]',
  created_by text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_library_active_question_unique
  ON prompt_library_questions(organization_id, industry, question) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS prompt_library_organization_industry_idx
  ON prompt_library_questions(organization_id, industry, created_at);

ALTER TABLE prompts ADD COLUMN IF NOT EXISTS library_question_id text
  REFERENCES prompt_library_questions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prompts_library_question_idx ON prompts(library_question_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_super_admin_idx ON users(is_super_admin) WHERE is_super_admin=true;
UPDATE users SET is_super_admin=true
WHERE id=(
  SELECT id FROM users WHERE organization_id='default' AND role='admin' AND disabled_at IS NULL
  ORDER BY created_at LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM users WHERE is_super_admin=true);

ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS word_artifact_key text;
