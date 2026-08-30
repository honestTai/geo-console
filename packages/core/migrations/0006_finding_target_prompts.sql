ALTER TABLE diagnosis_findings
  ADD COLUMN IF NOT EXISTS target_prompt_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
