-- AI 工作台会话、优化文章、Agent 思考强度与新增权限。

CREATE TABLE IF NOT EXISTS agent_sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  auto_approve boolean NOT NULL DEFAULT true,
  model text,
  thinking_level text,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  waiting jsonb,
  current_batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  usage jsonb,
  error_message text,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_turn_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_sessions_project_idx ON agent_sessions(project_id,created_at);
CREATE INDEX IF NOT EXISTS agent_sessions_status_idx ON agent_sessions(status);

CREATE TABLE IF NOT EXISTS agent_session_events (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id,seq)
);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS approved_via text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS thinking_level text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS target_ref jsonb;
CREATE INDEX IF NOT EXISTS agent_runs_session_idx ON agent_runs(session_id);

CREATE TABLE IF NOT EXISTS optimization_articles (
  id text PRIMARY KEY,
  organization_id text NOT NULL DEFAULT 'default' REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id text REFERENCES experiment_batches(id) ON DELETE SET NULL,
  source_run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  narrative_run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  recommendation_index integer NOT NULL DEFAULT 0,
  recommendation_title text NOT NULL,
  recommendation_action text,
  recommendation_priority text,
  title text NOT NULL,
  summary text,
  status text NOT NULL DEFAULT 'draft',
  content_markdown text NOT NULL DEFAULT '',
  outline jsonb NOT NULL DEFAULT '[]'::jsonb,
  fact_gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_prompt_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_url text,
  version integer NOT NULL DEFAULT 1,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS optimization_articles_project_idx ON optimization_articles(project_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS optimization_articles_narrative_idx
  ON optimization_articles(narrative_run_id,recommendation_index) WHERE narrative_run_id IS NOT NULL;

INSERT INTO permissions (key,kind,group_label,label,navigation_key,icon_key,system_only,desktop_only,position) VALUES
  ('page.workbench','page','客户工作台','AI 工作台','workbench','sparkles',false,false,5),
  ('page.articles','page','客户工作台','优化文章','articles','article',false,false,85),
  ('workbench.run','action','Agent','使用 AI 工作台运行全流程',NULL,NULL,false,false,285),
  ('articles.manage','action','整改','生成与编辑优化文章',NULL,NULL,false,false,295)
ON CONFLICT (key) DO UPDATE SET
  kind=excluded.kind,group_label=excluded.group_label,label=excluded.label,navigation_key=excluded.navigation_key,
  icon_key=excluded.icon_key,system_only=excluded.system_only,desktop_only=excluded.desktop_only,position=excluded.position;

INSERT INTO permission_routes (id,permission_key,http_method,path_pattern,position) VALUES
  ('route-projects-read-workbench','page.workbench','GET','/api/projects',18),
  ('route-project-read-workbench','page.workbench','GET','/api/projects/:projectId',28),
  ('route-projects-read-articles','page.articles','GET','/api/projects',19),
  ('route-project-read-articles','page.articles','GET','/api/projects/:projectId',29),
  ('route-workbench-sessions-list','page.workbench','GET','/api/projects/:projectId/workbench/sessions',400),
  ('route-workbench-session-read','page.workbench','GET','/api/workbench/sessions/:sessionId',401),
  ('route-workbench-session-events','page.workbench','GET','/api/workbench/sessions/:sessionId/events',402),
  ('route-workbench-session-create','workbench.run','POST','/api/projects/:projectId/workbench/sessions',410),
  ('route-workbench-session-message','workbench.run','POST','/api/workbench/sessions/:sessionId/messages',411),
  ('route-workbench-session-answer','workbench.run','POST','/api/workbench/sessions/:sessionId/answer',412),
  ('route-workbench-session-cancel','workbench.run','POST','/api/workbench/sessions/:sessionId/cancel',413),
  ('route-workbench-session-settings','workbench.run','PATCH','/api/workbench/sessions/:sessionId/settings',414),
  ('route-workbench-batch-read','page.workbench','GET','/api/batches/:batchId',415),
  ('route-workbench-reports-read','page.workbench','GET','/api/projects/:projectId/reports',416),
  ('route-workbench-articles-read','page.workbench','GET','/api/projects/:projectId/articles',417),
  ('route-articles-list','page.articles','GET','/api/projects/:projectId/articles',420),
  ('route-articles-read','page.articles','GET','/api/articles/:articleId',421),
  ('route-articles-generate','articles.manage','POST','/api/projects/:projectId/articles/generate',430),
  ('route-articles-update','articles.manage','PATCH','/api/articles/:articleId',431),
  ('route-articles-delete','articles.manage','DELETE','/api/articles/:articleId',432),
  ('route-articles-regenerate','articles.manage','POST','/api/articles/:articleId/regenerate',433),
  ('route-articles-agent-runs','page.articles','GET','/api/projects/:projectId/agent-runs',434),
  ('route-articles-reports-read','page.articles','GET','/api/projects/:projectId/reports',435)
ON CONFLICT (permission_key,http_method,path_pattern) DO UPDATE SET position=excluded.position;

INSERT INTO organization_permissions (organization_id,permission_key)
SELECT o.id,p.key FROM organizations o CROSS JOIN permissions p
WHERE p.key IN ('page.workbench','page.articles','workbench.run','articles.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id,permission_key)
SELECT r.id,p.key FROM roles r JOIN permissions p ON p.key IN ('page.workbench','page.articles','workbench.run','articles.manage')
WHERE r.name IN ('机构管理员','业务分析师')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id,permission_key)
SELECT r.id,p.key FROM roles r JOIN permissions p ON p.key IN ('page.workbench','page.articles')
WHERE r.name='只读成员'
ON CONFLICT DO NOTHING;
