-- Organization customer directory: a navigation/read permission, not a grant of write or project-wide access.
INSERT INTO permissions(key,kind,group_label,label,navigation_key,icon_key,system_only,desktop_only,position,built_in)
VALUES ('page.customers','page','机构管理','客户管理','customers','building',false,false,88,true);

-- Existing overview readers already have customer-list access; preserve that scope in the new menu.
INSERT INTO organization_permissions(organization_id,permission_key,granted_by)
SELECT organization_id,'page.customers',granted_by FROM organization_permissions WHERE permission_key='page.overview'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_key)
SELECT role_id,'page.customers' FROM role_permissions WHERE permission_key='page.overview'
ON CONFLICT DO NOTHING;

-- Only list/profile rows. Detailed evidence APIs and all write policies keep their existing requirements.
UPDATE authorization_policies SET any_of=any_of || '["page.customers"]'::jsonb
WHERE kind='http' AND http_method='GET' AND path_pattern='/api/projects' AND NOT (any_of ? 'page.customers');
