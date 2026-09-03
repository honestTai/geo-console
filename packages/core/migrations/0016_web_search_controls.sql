-- 联网搜索治理：会话级联网开关、竞品联网核实结论、联网搜索证据列表与按模型的联网测试入口。

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS web_search_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS verification jsonb;

INSERT INTO permission_routes (id,permission_key,http_method,path_pattern,position) VALUES
  ('route-evidence-web-searches','page.evidence','GET','/api/projects/:projectId/web-searches',62),
  ('route-overview-web-searches','page.overview','GET','/api/projects/:projectId/web-searches',63),
  ('route-diagnosis-web-searches','page.diagnosis','GET','/api/projects/:projectId/web-searches',64),
  ('route-remediation-web-searches','page.remediation','GET','/api/projects/:projectId/web-searches',65),
  ('route-report-web-searches','page.report','GET','/api/projects/:projectId/web-searches',66),
  ('route-workbench-web-searches','page.workbench','GET','/api/projects/:projectId/web-searches',419),
  ('route-workbench-web-search-status','page.workbench','GET','/api/settings/hrouter/web-search-status',421),
  ('route-workbench-web-search-test','workbench.run','POST','/api/settings/hrouter/test-web-search',422),
  ('route-onboard-agent-research','project.onboard','POST','/api/projects/:projectId/agent',51),
  ('route-onboard-agent-runs','page.overview','GET','/api/projects/:projectId/agent-runs',173)
ON CONFLICT (permission_key,http_method,path_pattern) DO UPDATE SET position=excluded.position;
