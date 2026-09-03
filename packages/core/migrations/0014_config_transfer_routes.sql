-- 工作台读取 HRouter 模型列表的路由放行；问题知识库导入/导出路由。
-- 平台设置导入/导出走已有的 /api/settings/* 通配策略（GET→page.settings，POST→settings.manage）。

INSERT INTO permission_routes (id,permission_key,http_method,path_pattern,position) VALUES
  ('route-workbench-hrouter-models','page.workbench','GET','/api/settings/hrouter/models',418),
  ('route-knowledge-export','page.knowledge','GET','/api/knowledge/export',372),
  ('route-knowledge-import','knowledge.manage','POST','/api/knowledge/import',382)
ON CONFLICT (permission_key,http_method,path_pattern) DO UPDATE SET position=excluded.position;
