-- HRouter Agent 联网搜索证据：每次 web_search 工具调用落一条记录，草稿只能引用这里的 ID。

CREATE TABLE IF NOT EXISTS web_search_evidence (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  agent_run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  backend text NOT NULL,
  model text NOT NULL,
  query text NOT NULL,
  status text NOT NULL,
  answer_text text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_queries jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_response jsonb,
  usage jsonb,
  latency_ms integer,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_search_evidence_project_idx ON web_search_evidence(project_id,created_at);
CREATE INDEX IF NOT EXISTS web_search_evidence_session_idx ON web_search_evidence(session_id);
