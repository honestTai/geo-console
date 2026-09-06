-- These grants have never been effective: the authorization kernel excludes system-only permissions for tenants.
-- Remove invalid dormant grants so an ordinary administrator can delegate standard tenant roles safely.
DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_key=p.key AND p.system_only=true;
DELETE FROM organization_permissions op USING permissions p WHERE op.permission_key=p.key AND p.system_only=true;

CREATE FUNCTION geo_reject_system_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM permissions WHERE key=NEW.permission_key AND system_only=true) THEN
  RAISE EXCEPTION 'System-only permissions cannot be assigned to organizations or tenant roles' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER geo_role_grant_boundary BEFORE INSERT OR UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION geo_reject_system_grant();
CREATE TRIGGER geo_organization_grant_boundary BEFORE INSERT OR UPDATE ON organization_permissions FOR EACH ROW EXECUTE FUNCTION geo_reject_system_grant();
