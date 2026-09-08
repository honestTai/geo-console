CREATE TABLE customer_knowledge_assets (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 project_id text NOT NULL REFERENCES projects(id), title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('product','case','fact','material')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','archived')),
 current_revision integer NOT NULL DEFAULT 1, created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_knowledge_assets_project_idx ON customer_knowledge_assets(project_id,status,updated_at DESC);
CREATE TABLE customer_knowledge_revisions (
 id text PRIMARY KEY, asset_id text NOT NULL REFERENCES customer_knowledge_assets(id),
 project_id text NOT NULL REFERENCES projects(id), revision integer NOT NULL,
 title text NOT NULL, kind text NOT NULL, content text NOT NULL, source_url text, source_note text NOT NULL,
 valid_until timestamptz, content_hash text NOT NULL, created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,revision)
);
CREATE TABLE customer_knowledge_reviews (
 id text PRIMARY KEY, revision_id text NOT NULL REFERENCES customer_knowledge_revisions(id),
 project_id text NOT NULL REFERENCES projects(id), decision text NOT NULL CHECK(decision IN ('approve','reject','archive')),
 note text NOT NULL, actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['customer_knowledge_assets','customer_knowledge_revisions','customer_knowledge_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['customer_knowledge_revisions','customer_knowledge_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER knowledge_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_article_immutable()',table_name);
 END LOOP;
END $$;
