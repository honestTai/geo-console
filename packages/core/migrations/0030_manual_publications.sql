CREATE TABLE publication_channels (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), project_id text NOT NULL REFERENCES projects(id),
 name text NOT NULL, platform text NOT NULL, account_name text NOT NULL, profile_url text,
 target_url text, instructions text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_orders (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), project_id text NOT NULL REFERENCES projects(id),
 article_id text NOT NULL REFERENCES optimization_articles(id), article_version integer NOT NULL,
 article_snapshot jsonb NOT NULL, channel_id text NOT NULL REFERENCES publication_channels(id), channel_snapshot jsonb NOT NULL,
 assigned_to text REFERENCES users(id), scheduled_at timestamptz,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','in_progress','submitted','verified','failed','cancelled','outcome_unknown')),
 notes text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1,
 created_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, FOREIGN KEY(article_id,article_version) REFERENCES article_versions(article_id,version)
);
CREATE INDEX publication_orders_project_idx ON publication_orders(project_id,status,scheduled_at,created_at DESC);
CREATE UNIQUE INDEX publication_orders_active_idx ON publication_orders(article_id,article_version,channel_id)
 WHERE status NOT IN ('failed','cancelled');
CREATE TABLE publication_receipts (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES publication_orders(id), project_id text NOT NULL REFERENCES projects(id),
 result_url text NOT NULL, note text NOT NULL, actor jsonb NOT NULL, submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_events (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES publication_orders(id), project_id text NOT NULL REFERENCES projects(id),
 from_status text, to_status text NOT NULL, note text NOT NULL, actor jsonb NOT NULL, receipt_id text REFERENCES publication_receipts(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['publication_channels','publication_orders','publication_receipts','publication_events'] LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['publication_receipts','publication_events'] LOOP
  EXECUTE format('CREATE TRIGGER publication_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_article_immutable()',table_name);
 END LOOP;
END $$;
