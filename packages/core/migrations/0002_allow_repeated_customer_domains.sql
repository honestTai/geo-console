DROP INDEX IF EXISTS projects_domain_unique;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_domain_key;
