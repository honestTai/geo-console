-- 桌面 Agent Runtime：客户端领取交互回合，服务端只代理模型请求并执行受限业务工具。

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS execution_target text NOT NULL DEFAULT 'server';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_pending_trigger text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_pending_message text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_turn_start_index integer;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_run_id text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_client_id text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS desktop_lease_expires_at timestamptz;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS event_seq integer NOT NULL DEFAULT 0;

UPDATE agent_sessions s
SET event_seq=COALESCE((SELECT max(e.seq) FROM agent_session_events e WHERE e.session_id=s.id),0);

ALTER TABLE agent_session_events ADD COLUMN IF NOT EXISTS client_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS agent_session_events_client_unique
  ON agent_session_events(session_id,client_event_id) WHERE client_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS desktop_agent_tool_calls (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb NOT NULL,
  args_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  result jsonb,
  error_message text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(session_id,tool_call_id)
);
CREATE INDEX IF NOT EXISTS desktop_agent_tool_calls_session_idx
  ON desktop_agent_tool_calls(session_id,created_at);

INSERT INTO permission_routes (id,permission_key,http_method,path_pattern,position) VALUES
  ('route-workbench-desktop-claim','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/claim',423),
  ('route-workbench-desktop-heartbeat','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/heartbeat',424),
  ('route-workbench-desktop-event','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/events',425),
  ('route-workbench-desktop-message','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/messages',426),
  ('route-workbench-desktop-tool','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/tools',427),
  ('route-workbench-desktop-complete','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/complete',428),
  ('route-workbench-desktop-responses','workbench.run','POST','/api/workbench/sessions/:sessionId/desktop/responses',429)
ON CONFLICT (permission_key,http_method,path_pattern) DO UPDATE SET position=excluded.position;
