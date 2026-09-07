-- Additive only: old articles stay explicit about their missing publication plans.
ALTER TABLE optimization_articles ADD COLUMN publication_plan jsonb;

INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,any_of,resource_type,resource_param,scope,built_in)
VALUES ('http:evidence:reference','GET /api/projects/:projectId/evidence-reference/:evidenceId','http','定位客户证据（不授予正文或文件读取权限）','GET','/api/projects/:projectId/evidence-reference/:evidenceId','["page.audit","page.evidence","page.diagnosis","page.report","page.workbench","page.articles","page.monitor"]','project','projectId','project',true);
