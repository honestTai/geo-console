-- A missing official website is not an error, and must not become a fabricated domain.
ALTER TABLE projects ALTER COLUMN website_url DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN domain DROP NOT NULL;

INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,all_of,resource_type,resource_param,scope,built_in)
VALUES ('http:project:edit','PUT /api/projects/:projectId','http','编辑客户基本信息','PUT','/api/projects/:projectId','["project.onboard"]','project','projectId','project',true);

INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,any_of,resource_type,resource_param,scope,built_in)
VALUES ('http:website:evidence','GET /api/projects/:projectId/website-evidence/:evidenceId','http','读取不可变官网证据','GET','/api/projects/:projectId/website-evidence/:evidenceId','["page.audit","page.evidence","page.diagnosis","page.report","page.workbench"]','project','projectId','project',true);
