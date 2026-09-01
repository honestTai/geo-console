ALTER TABLE users ADD COLUMN IF NOT EXISTS all_projects boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS users_single_super_admin_unique ON users(is_super_admin) WHERE is_super_admin=true;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE TABLE IF NOT EXISTS permissions (
  key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('page', 'action')),
  group_label text NOT NULL,
  label text NOT NULL,
  navigation_key text,
  icon_key text,
  system_only boolean NOT NULL DEFAULT false,
  desktop_only boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0
);

INSERT INTO permissions (key,kind,group_label,label,navigation_key,icon_key,system_only,desktop_only,position) VALUES
  ('page.overview','page','客户工作台','项目总览','overview','building',false,false,10),
  ('page.monitor','page','客户工作台','AI 监测','monitor','activity',false,false,20),
  ('page.evidence','page','客户工作台','证据中心','evidence','database',false,false,30),
  ('page.audit','page','客户工作台','官网审计','audit','shield',false,false,40),
  ('page.diagnosis','page','客户工作台','差距诊断','diagnosis','search',false,false,50),
  ('page.remediation','page','客户工作台','整改中心','remediation','checklist',false,false,60),
  ('page.attribution','page','客户工作台','业务归因','attribution','route',false,false,70),
  ('page.report','page','客户工作台','复测报告','report','report',false,false,80),
  ('page.knowledge','page','机构管理','问题知识库','knowledge','book',false,false,90),
  ('page.settings','page','机构管理','平台设置','settings','settings',false,false,100),
  ('page.members','page','机构管理','机构成员','members','users',false,false,110),
  ('page.audit_logs','page','机构管理','审计日志','auditLogs','history',false,false,120),
  ('page.service_logs','page','机构管理','运行日志','serviceLogs','activity',false,false,130),
  ('page.rbac','page','系统管理','权限配置','rbac','lock',true,true,140),
  ('page.organizations','page','系统管理','多租户管理','organizations','organizations',true,true,150),
  ('project.create','action','客户与建档','新建客户',NULL,NULL,false,false,210),
  ('project.onboard','action','客户与建档','分析并确认客户建档',NULL,NULL,false,false,220),
  ('monitor.run','action','监测','运行快审、基线与复测',NULL,NULL,false,false,230),
  ('monitor.schedule','action','监测','配置自动监测',NULL,NULL,false,false,240),
  ('audit.run','action','分析','运行官网审计',NULL,NULL,false,false,250),
  ('diagnosis.run','action','分析','生成规则诊断',NULL,NULL,false,false,260),
  ('agent.run','action','Agent','运行 Agent 草稿',NULL,NULL,false,false,270),
  ('agent.approve','action','Agent','批准或拒绝 Agent 草稿',NULL,NULL,false,false,280),
  ('remediation.manage','action','整改','管理整改任务与验收',NULL,NULL,false,false,290),
  ('attribution.import','action','归因','导入业务归因数据',NULL,NULL,false,false,300),
  ('report.generate','action','报告','生成报告与文档',NULL,NULL,false,false,310),
  ('report.share','action','报告','创建和撤销报告分享',NULL,NULL,false,false,320),
  ('knowledge.manage','action','机构管理','维护问题知识库',NULL,NULL,false,false,330),
  ('settings.manage','action','机构管理','维护模型与平台设置',NULL,NULL,false,false,340),
  ('members.manage','action','机构管理','新增和停用成员',NULL,NULL,false,false,350),
  ('logs.export','action','日志','导出运行日志',NULL,NULL,false,false,360),
  ('logs.retention','action','日志','执行日志保留清理',NULL,NULL,false,false,370),
  ('rbac.manage','action','系统管理','管理角色与用户授权',NULL,NULL,true,true,380),
  ('organization.manage','action','系统管理','管理机构与机构授权',NULL,NULL,true,true,390)
ON CONFLICT (key) DO UPDATE SET
  kind=excluded.kind,group_label=excluded.group_label,label=excluded.label,navigation_key=excluded.navigation_key,
  icon_key=excluded.icon_key,system_only=excluded.system_only,desktop_only=excluded.desktop_only,position=excluded.position;

CREATE TABLE IF NOT EXISTS permission_routes (
  id text PRIMARY KEY,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  http_method text NOT NULL,
  path_pattern text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  UNIQUE (permission_key,http_method,path_pattern)
);
CREATE INDEX IF NOT EXISTS permission_routes_method_idx ON permission_routes(http_method,position);

CREATE TABLE IF NOT EXISTS organization_permissions (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,permission_key)
);

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id,permission_key)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id,role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles(role_id);

CREATE TABLE IF NOT EXISTS user_project_access (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id,project_id)
);
CREATE INDEX IF NOT EXISTS user_project_access_project_idx ON user_project_access(project_id);

INSERT INTO organization_permissions (organization_id,permission_key)
SELECT o.id,p.key FROM organizations o CROSS JOIN permissions p WHERE p.system_only=false
ON CONFLICT DO NOTHING;

INSERT INTO roles (id,organization_id,name,description,is_system)
SELECT 'role:' || md5(o.id) || ':admin',o.id,'机构管理员','迁移生成的默认角色，可继续调整权限',true FROM organizations o
UNION ALL
SELECT 'role:' || md5(o.id) || ':analyst',o.id,'业务分析师','迁移生成的默认角色，可继续调整权限',true FROM organizations o
UNION ALL
SELECT 'role:' || md5(o.id) || ':viewer',o.id,'只读成员','迁移生成的默认角色，可继续调整权限',true FROM organizations o
ON CONFLICT (organization_id,name) DO NOTHING;

INSERT INTO role_permissions (role_id,permission_key)
SELECT r.id,p.key FROM roles r JOIN permissions p ON p.system_only=false WHERE r.name='机构管理员'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id,permission_key)
SELECT r.id,p.key FROM roles r JOIN permissions p ON true
WHERE r.name='业务分析师' AND p.system_only=false AND p.key NOT IN (
  'page.settings','page.members','page.audit_logs','page.service_logs','page.rbac',
  'settings.manage','members.manage','logs.export','logs.retention','rbac.manage'
)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id,permission_key)
SELECT r.id,p.key FROM roles r JOIN permissions p ON p.kind='page'
WHERE r.name='只读成员' AND p.system_only=false
ON CONFLICT DO NOTHING;

INSERT INTO permission_routes (id,permission_key,http_method,path_pattern,position) VALUES
  ('route-projects-read','page.overview','GET','/api/projects',10),
  ('route-project-read','page.overview','GET','/api/projects/:projectId',20),
  ('route-projects-read-monitor','page.monitor','GET','/api/projects',11),
  ('route-project-read-monitor','page.monitor','GET','/api/projects/:projectId',21),
  ('route-projects-read-evidence','page.evidence','GET','/api/projects',12),
  ('route-project-read-evidence','page.evidence','GET','/api/projects/:projectId',22),
  ('route-projects-read-audit','page.audit','GET','/api/projects',13),
  ('route-project-read-audit','page.audit','GET','/api/projects/:projectId',23),
  ('route-projects-read-diagnosis','page.diagnosis','GET','/api/projects',14),
  ('route-project-read-diagnosis','page.diagnosis','GET','/api/projects/:projectId',24),
  ('route-projects-read-remediation','page.remediation','GET','/api/projects',15),
  ('route-project-read-remediation','page.remediation','GET','/api/projects/:projectId',25),
  ('route-projects-read-attribution','page.attribution','GET','/api/projects',16),
  ('route-project-read-attribution','page.attribution','GET','/api/projects/:projectId',26),
  ('route-projects-read-report','page.report','GET','/api/projects',17),
  ('route-project-read-report','page.report','GET','/api/projects/:projectId',27),
  ('route-project-create','project.create','POST','/api/projects',30),
  ('route-project-analyze','project.onboard','POST','/api/projects/:projectId/analyze',40),
  ('route-project-confirm','project.onboard','POST','/api/projects/:projectId/confirm',50),
  ('route-monitor-batch-read','page.monitor','GET','/api/batches/:batchId',60),
  ('route-evidence-batch-read','page.evidence','GET','/api/batches/:batchId',61),
  ('route-diagnosis-batch-read','page.diagnosis','GET','/api/batches/:batchId',62),
  ('route-report-batch-read','page.report','GET','/api/batches/:batchId',63),
  ('route-monitor-trends','page.monitor','GET','/api/projects/:projectId/trends/*',70),
  ('route-overview-trends','page.overview','GET','/api/projects/:projectId/trends/*',71),
  ('route-monitor-costs','page.monitor','GET','/api/projects/:projectId/costs',80),
  ('route-monitor-alerts','page.monitor','GET','/api/projects/:projectId/drift-alerts',90),
  ('route-monitor-run','monitor.run','POST','/api/projects/:projectId/batches',100),
  ('route-monitor-schedule','monitor.schedule','PUT','/api/projects/:projectId/monitoring-schedule',110),
  ('route-monitor-alert-ack','monitor.run','POST','/api/drift-alerts/:alertId/acknowledge',120),
  ('route-audit-run','audit.run','POST','/api/projects/:projectId/audit',130),
  ('route-diagnosis-rule','diagnosis.run','POST','/api/batches/:batchId/diagnose',140),
  ('route-agent-run-model','agent.run','POST','/api/batches/:batchId/diagnose/model',150),
  ('route-agent-run','agent.run','POST','/api/batches/:batchId/agent',160),
  ('route-agent-list-diagnosis','page.diagnosis','GET','/api/projects/:projectId/agent-runs',170),
  ('route-agent-list-remediation','page.remediation','GET','/api/projects/:projectId/agent-runs',171),
  ('route-agent-list-report','page.report','GET','/api/projects/:projectId/agent-runs',172),
  ('route-agent-approve','agent.approve','POST','/api/agent-runs/:runId/approve',180),
  ('route-agent-reject','agent.approve','POST','/api/agent-runs/:runId/reject',190),
  ('route-remediation-create','remediation.manage','POST','/api/projects/:projectId/tasks/from-findings',200),
  ('route-remediation-update','remediation.manage','PATCH','/api/tasks/:taskId',210),
  ('route-remediation-delete','remediation.manage','DELETE','/api/tasks/:taskId',220),
  ('route-remediation-verify','remediation.manage','POST','/api/tasks/:taskId/verify',230),
  ('route-remediation-content','agent.run','POST','/api/tasks/:taskId/content',240),
  ('route-attribution-read','page.attribution','GET','/api/projects/:projectId/attribution',250),
  ('route-attribution-import','attribution.import','POST','/api/projects/:projectId/attribution/import',260),
  ('route-report-read','page.report','GET','/api/projects/:projectId/reports',270),
  ('route-report-detail','page.report','GET','/api/reports/:reportId',280),
  ('route-report-batch-analysis','page.report','GET','/api/batches/:batchId/report',281),
  ('route-report-status','page.report','GET','/api/reports/:reportId/pdf',290),
  ('route-report-export','page.report','GET','/api/reports/:reportId/export.csv',300),
  ('route-report-workflow','report.generate','POST','/api/batches/:batchId/report-workflow',310),
  ('route-report-snapshot','report.generate','POST','/api/batches/:batchId/reports',320),
  ('route-report-document','report.generate','POST','/api/reports/:reportId/pdf',330),
  ('route-report-share-list','page.report','GET','/api/reports/:reportId/shares',340),
  ('route-report-share-create','report.share','POST','/api/reports/:reportId/shares',350),
  ('route-report-share-revoke','report.share','DELETE','/api/report-shares/:shareId',360),
  ('route-knowledge-read','page.knowledge','GET','/api/knowledge/questions',370),
  ('route-knowledge-create','knowledge.manage','POST','/api/knowledge/questions',380),
  ('route-knowledge-delete','knowledge.manage','DELETE','/api/knowledge/questions/:questionId',390),
  ('route-settings-read','page.settings','GET','/api/settings/*',400),
  ('route-settings-put','settings.manage','PUT','/api/settings/*',410),
  ('route-settings-test','settings.manage','POST','/api/settings/*',420),
  ('route-members-read','page.members','GET','/api/users',430),
  ('route-rbac-members-read','page.rbac','GET','/api/users',431),
  ('route-members-create','members.manage','POST','/api/users',440),
  ('route-members-disable','members.manage','DELETE','/api/users/:userId',450),
  ('route-audit-logs','page.audit_logs','GET','/api/audit-logs',460),
  ('route-service-logs','page.service_logs','GET','/api/service-logs',470),
  ('route-service-logs-export','logs.export','GET','/api/service-logs/export.csv',480),
  ('route-service-logs-retention','logs.retention','POST','/api/service-logs/retention',490),
  ('route-rbac-catalog','page.rbac','GET','/api/rbac/catalog',500),
  ('route-rbac-roles-read','page.rbac','GET','/api/rbac/roles',510),
  ('route-members-roles-read','page.members','GET','/api/rbac/roles',511),
  ('route-rbac-role-create','rbac.manage','POST','/api/rbac/roles',520),
  ('route-rbac-role-update','rbac.manage','PUT','/api/rbac/roles/:roleId',530),
  ('route-rbac-role-delete','rbac.manage','DELETE','/api/rbac/roles/:roleId',540),
  ('route-rbac-user-access','rbac.manage','PUT','/api/users/:userId/access',550),
  ('route-organizations-read','page.organizations','GET','/api/organizations',560),
  ('route-organizations-create','organization.manage','POST','/api/organizations',570),
  ('route-organizations-entitlements','organization.manage','PUT','/api/organizations/:organizationId/permissions',580),
  ('route-organizations-status','organization.manage','PUT','/api/organizations/:organizationId/status',590)
ON CONFLICT (permission_key,http_method,path_pattern) DO UPDATE SET position=excluded.position;

INSERT INTO user_roles (user_id,role_id)
SELECT u.id,r.id FROM users u JOIN roles r ON r.organization_id=u.organization_id
 AND r.name=CASE u.role WHEN 'admin' THEN '机构管理员' WHEN 'analyst' THEN '业务分析师' ELSE '只读成员' END
ON CONFLICT DO NOTHING;
