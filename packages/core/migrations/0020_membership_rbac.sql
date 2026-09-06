-- Stable system-role identity is independent of its editable display name. Never restore revoked permissions.
ALTER TABLE roles ADD COLUMN system_key text CHECK(system_key IS NULL OR system_key IN ('admin','analyst','viewer'));
ALTER TABLE users ALTER COLUMN all_projects SET DEFAULT false;
UPDATE roles SET system_key=CASE
 WHEN id LIKE 'role:%:admin' THEN 'admin'
 WHEN id LIKE 'role:%:analyst' THEN 'analyst'
 WHEN id LIKE 'role:%:viewer' THEN 'viewer'
 WHEN name='机构管理员' THEN 'admin'
 WHEN name='业务分析师' THEN 'analyst'
 WHEN name='只读成员' THEN 'viewer'
 ELSE NULL END WHERE is_system=true;
CREATE UNIQUE INDEX roles_organization_system_key_unique ON roles(organization_id,system_key) WHERE system_key IS NOT NULL;
INSERT INTO permission_routes(id,permission_key,http_method,path_pattern,position) VALUES
 ('route-member-options','members.manage','GET','/api/users/options',511),
 ('route-members-restore','members.manage','POST','/api/users/:userId/restore',451),
 ('route-members-password','members.manage','POST','/api/users/:userId/password',452);

UPDATE permissions SET label='新增、停用、恢复及重置成员密码' WHERE key='members.manage';
