ALTER TABLE users ADD COLUMN credential_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN authz_version integer NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN authz_version integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN credential_version integer NOT NULL DEFAULT 0;
ALTER TABLE permissions ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE permissions ADD COLUMN parent_key text REFERENCES permissions(key);
ALTER TABLE permissions ADD COLUMN built_in boolean NOT NULL DEFAULT true;
ALTER TABLE permissions ALTER COLUMN built_in SET DEFAULT false;
ALTER TABLE agent_runs ADD COLUMN execution_actor jsonb NOT NULL DEFAULT '{"kind":"unassigned"}';
ALTER TABLE agent_sessions ADD COLUMN execution_actor jsonb NOT NULL DEFAULT '{"kind":"unassigned"}';
UPDATE agent_sessions SET execution_actor=jsonb_build_object('kind','user','userId',created_by) WHERE created_by IS NOT NULL;
UPDATE agent_runs r SET execution_actor=s.execution_actor FROM agent_sessions s WHERE r.session_id=s.id;

CREATE TABLE authorization_policies(
 id text PRIMARY KEY, policy_key text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('http','artifact','execution')),
 label text NOT NULL, http_method text, path_pattern text, any_of jsonb NOT NULL DEFAULT '[]', all_of jsonb NOT NULL DEFAULT '[]',
 resource_type text NOT NULL DEFAULT 'organization', resource_param text, scope text NOT NULL CHECK(scope IN ('organization','project','system')),
 owner_only boolean NOT NULL DEFAULT false, system_only boolean NOT NULL DEFAULT false, allow_suspended boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true, built_in boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(any_of)='array' AND jsonb_typeof(all_of)='array'),
 CHECK((kind='http' AND http_method IS NOT NULL AND path_pattern IS NOT NULL) OR (kind<>'http' AND http_method IS NULL AND path_pattern IS NULL)),
 UNIQUE(http_method,path_pattern)
);
CREATE INDEX authorization_policies_kind_idx ON authorization_policies(kind,http_method);

-- Collapse old per-permission OR rows into explicit, inspectable policies. Specific rules win over wildcards.
INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,any_of,resource_type,resource_param,scope,system_only,allow_suspended,built_in)
SELECT 'http:'||md5(http_method||':'||path_pattern),http_method||' '||path_pattern,'http',http_method||' '||path_pattern,http_method,path_pattern,
 jsonb_agg(DISTINCT permission_key),
 CASE WHEN path_pattern LIKE '/api/organizations/%' THEN 'organization'
 WHEN path_pattern LIKE '/api/projects/:%' THEN 'project' WHEN path_pattern LIKE '/api/batches/:%' THEN 'batch'
 WHEN path_pattern LIKE '/api/agent-runs/:%' THEN 'agent_run' WHEN path_pattern LIKE '/api/tasks/:%' THEN 'task'
 WHEN path_pattern LIKE '/api/reports/:%' THEN 'report' WHEN path_pattern LIKE '/api/report-shares/:%' THEN 'report_share'
 WHEN path_pattern LIKE '/api/workbench/sessions/:%' THEN 'session' WHEN path_pattern LIKE '/api/articles/:%' THEN 'article'
 WHEN path_pattern LIKE '/api/drift-alerts/:%' THEN 'drift_alert' WHEN path_pattern LIKE '/api/users/:%' THEN 'member'
 WHEN path_pattern LIKE '/api/rbac/roles/:%' THEN 'role' ELSE 'organization' END,
 substring(path_pattern FROM '/:([A-Za-z][A-Za-z0-9_]*)'),
 CASE WHEN path_pattern LIKE '/api/organizations%' THEN 'system'
 WHEN path_pattern ~ '^/api/(projects|batches|agent-runs|tasks|reports|report-shares|articles|drift-alerts)/:' OR path_pattern LIKE '/api/workbench/sessions/:%' THEN 'project'
 ELSE 'organization' END,
 bool_and(permission_key IN ('rbac.manage','organization.manage','page.rbac','page.organizations')),
 bool_and(permission_key IN ('rbac.manage','organization.manage','page.rbac','page.organizations')),true
FROM permission_routes GROUP BY http_method,path_pattern;

INSERT INTO authorization_policies(id,policy_key,kind,label,any_of,all_of,resource_type,scope,built_in) VALUES
 ('artifact:capture','artifact.capture.read','artifact','读取采集原始证据','["page.evidence","page.monitor","page.report","page.diagnosis"]','[]','project','project',true),
 ('artifact:website','artifact.website.read','artifact','读取官网证据','["page.evidence","page.audit","page.diagnosis","page.report","page.workbench"]','[]','project','project',true),
 ('artifact:report','artifact.report.read','artifact','下载报告文件','["page.report"]','[]','project','project',true),
 ('artifact:semantic','artifact.semantic.read','artifact','读取语义解析原始响应','["page.evidence"]','[]','project','project',true),
 ('execution:workbench','workbench.execute','execution','工作台回合与工具','[]','["workbench.run"]','project','project',true),
 ('execution:approval','agent.approve','execution','人工批准 Agent 草稿','[]','["agent.approve"]','project','project',true),
 ('execution:auto-approval','workbench.auto_approve','execution','工作台普通草稿自动审批','[]','["workbench.run","agent.approve"]','project','project',true),
 ('execution:article-approval','article.auto_approve','execution','文章草稿物化','["articles.manage","workbench.run"]','[]','project','project',true);
INSERT INTO authorization_policies(id,policy_key,kind,label,any_of,resource_type,scope,built_in) VALUES
 ('execution:members','members.manage','execution','成员委派与生命周期','["members.manage"]','organization','organization',true);
INSERT INTO authorization_policies(id,policy_key,kind,label,any_of,resource_type,scope,built_in)
SELECT 'execution:draft:'||purpose,'agent.draft.'||purpose,'execution','运行草稿：'||purpose,
 CASE WHEN purpose IN ('report_narrative','quality_review') THEN '["agent.run","report.generate","workbench.run"]'::jsonb
 WHEN purpose='optimization_article' THEN '["articles.manage","workbench.run"]'::jsonb
 WHEN purpose IN ('prompt_research','customer_profile') THEN '["agent.run","project.onboard","workbench.run"]'::jsonb
 ELSE '["agent.run","workbench.run"]'::jsonb END,'project','project',true
FROM unnest(ARRAY['customer_profile','prompt_research','diagnosis','remediation','content_brief','report_narrative','quality_review','optimization_article']) AS purpose;

CREATE FUNCTION geo_auth_credential_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN NEW.credential_version=OLD.credential_version+1; END IF;
 IF NEW.all_projects IS DISTINCT FROM OLD.all_projects OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at OR NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN NEW.authz_version=OLD.authz_version+1; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER geo_user_security_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION geo_auth_credential_version();
CREATE FUNCTION geo_authz_role_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE org text; BEGIN
 IF TG_TABLE_NAME='organization_permissions' THEN org=COALESCE(NEW.organization_id,OLD.organization_id);
 ELSIF TG_TABLE_NAME='roles' THEN org=COALESCE(NEW.organization_id,OLD.organization_id);
 ELSIF TG_TABLE_NAME='role_permissions' THEN SELECT organization_id INTO org FROM roles WHERE id=COALESCE(NEW.role_id,OLD.role_id);
 ELSE SELECT organization_id INTO org FROM users WHERE id=COALESCE(NEW.user_id,OLD.user_id); END IF;
 IF org IS NOT NULL THEN UPDATE organizations SET authz_version=authz_version+1 WHERE id=org; END IF;
 RETURN COALESCE(NEW,OLD); END $$;
CREATE TRIGGER geo_org_grants_version AFTER INSERT OR DELETE ON organization_permissions FOR EACH ROW EXECUTE FUNCTION geo_authz_role_change();
CREATE TRIGGER geo_roles_version AFTER INSERT OR UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION geo_authz_role_change();
CREATE TRIGGER geo_role_grants_version AFTER INSERT OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION geo_authz_role_change();
CREATE TRIGGER geo_user_roles_version AFTER INSERT OR DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION geo_authz_role_change();
CREATE TRIGGER geo_user_projects_version AFTER INSERT OR DELETE ON user_project_access FOR EACH ROW EXECUTE FUNCTION geo_authz_role_change();

UPDATE permissions SET parent_key='page.overview' WHERE key='project.create';
UPDATE permissions SET parent_key='page.overview' WHERE key='project.onboard';
UPDATE permissions SET parent_key='page.workbench' WHERE key='workbench.run';
UPDATE permissions SET parent_key='page.monitor' WHERE key='monitor.run';
UPDATE permissions SET parent_key='page.monitor' WHERE key='monitor.schedule';
UPDATE permissions SET parent_key='page.audit' WHERE key='audit.run';
UPDATE permissions SET parent_key='page.diagnosis' WHERE key='diagnosis.run';
UPDATE permissions SET parent_key='page.diagnosis' WHERE key='agent.run';
UPDATE permissions SET parent_key='page.report' WHERE key='agent.approve';
UPDATE permissions SET parent_key='page.remediation' WHERE key='remediation.manage';
UPDATE permissions SET parent_key='page.articles' WHERE key='articles.manage';
UPDATE permissions SET parent_key='page.attribution' WHERE key='attribution.import';
UPDATE permissions SET parent_key='page.report' WHERE key='report.generate';
UPDATE permissions SET parent_key='page.report' WHERE key='report.share';
UPDATE permissions SET parent_key='page.knowledge' WHERE key='knowledge.manage';
UPDATE permissions SET parent_key='page.settings' WHERE key='settings.manage';
UPDATE permissions SET parent_key='page.members' WHERE key='members.manage';
UPDATE permissions SET parent_key='page.service_logs' WHERE key='logs.export';
UPDATE permissions SET parent_key='page.service_logs' WHERE key='logs.retention';
UPDATE permissions SET parent_key='page.rbac' WHERE key='rbac.manage';
UPDATE permissions SET parent_key='page.organizations' WHERE key='organization.manage';
INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,any_of,scope,system_only,allow_suspended,built_in)
 SELECT 'config:'||md5(method||':'||path),method||' '||path,'http','授权中心配置',method,path,'["rbac.manage"]','system',true,true,true FROM (VALUES
 ('GET','/api/rbac/configuration/policies'),('POST','/api/rbac/configuration/policies'),('PUT','/api/rbac/configuration/policies/:id'),
 ('PUT','/api/rbac/configuration/permissions'),('POST','/api/rbac/configuration/explain')) routes(method,path);
UPDATE authorization_policies p SET any_of=(SELECT jsonb_agg(DISTINCT key) FROM (
 SELECT jsonb_array_elements_text(p.any_of) AS key UNION SELECT r.permission_key FROM permission_routes r
 WHERE r.http_method=p.http_method AND r.path_pattern LIKE '%*' AND p.path_pattern LIKE replace(r.path_pattern,'*','%')) merged)
 WHERE p.kind='http' AND p.built_in=true AND p.system_only=false;

-- Parameters such as providerId or questionId are not organization IDs. Their handlers scope queries by the active organization.
UPDATE authorization_policies SET resource_param=NULL WHERE kind='http' AND resource_type='organization' AND path_pattern NOT LIKE '/api/organizations/%';
UPDATE authorization_policies SET owner_only=true WHERE resource_type='session' AND http_method<>'GET';

CREATE FUNCTION geo_authz_organization_state() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at THEN NEW.authz_version=OLD.authz_version+1; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER geo_org_state_version BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION geo_authz_organization_state();

-- Each tool is independently configurable; workbench.run is not a substitute for domain write permissions.
INSERT INTO authorization_policies(id,policy_key,kind,label,any_of,all_of,resource_type,scope,built_in)
SELECT 'tool:'||name,'workbench.tool.'||name,'execution','工作台工具：'||name,'[]',
 CASE WHEN permission IS NULL THEN '["workbench.run"]'::jsonb ELSE jsonb_build_array('workbench.run',permission) END,'project','project',true
FROM (VALUES ('read_project_context',NULL),('suggest_questions',NULL),('ask_user',NULL),('propose_questions','project.onboard'),
 ('create_batch','monitor.run'),('get_batch_status',NULL),('wait_for',NULL),('verify_batch','monitor.run'),
 ('run_site_audit','audit.run'),('run_rule_diagnosis','diagnosis.run'),('run_agent_draft','agent.run'),
 ('advance_report','report.generate'),('generate_articles','articles.manage'),('finish',NULL),('web_search',NULL)) tools(name,permission);
