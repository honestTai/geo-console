CREATE TABLE article_versions (
 id text PRIMARY KEY, article_id text NOT NULL REFERENCES optimization_articles(id),
 project_id text NOT NULL REFERENCES projects(id), organization_id text NOT NULL REFERENCES organizations(id),
 version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(article_id,version)
);
CREATE TABLE article_quality_runs (
 id text PRIMARY KEY, article_id text NOT NULL REFERENCES optimization_articles(id),
 project_id text NOT NULL REFERENCES projects(id), organization_id text NOT NULL REFERENCES organizations(id),
 article_version integer NOT NULL, content_hash text NOT NULL, input_hash text NOT NULL,
 snapshot jsonb NOT NULL, sources jsonb NOT NULL, contract jsonb NOT NULL, execution_actor jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','failed','needs_review')),
 selected_attempt_id text, error_message text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 FOREIGN KEY(article_id,article_version) REFERENCES article_versions(article_id,version)
);
CREATE INDEX article_quality_runs_article_idx ON article_quality_runs(article_id,created_at DESC,id DESC);
CREATE TABLE article_quality_attempts (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES article_quality_runs(id), project_id text NOT NULL REFERENCES projects(id),
 attempt integer NOT NULL, result jsonb, validation jsonb NOT NULL DEFAULT '[]', raw_response jsonb NOT NULL,
 eligible boolean NOT NULL DEFAULT false, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,attempt)
);
CREATE TABLE article_quality_reviews (
 id text PRIMARY KEY, run_id text NOT NULL REFERENCES article_quality_runs(id), project_id text NOT NULL REFERENCES projects(id),
 decision text NOT NULL CHECK(decision IN ('approve','reject')), note text NOT NULL, actor jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE article_editorial_reviews (
 id text PRIMARY KEY, article_id text NOT NULL REFERENCES optimization_articles(id), project_id text NOT NULL REFERENCES projects(id),
 article_version integer NOT NULL, content_hash text NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','reject')),
 note text NOT NULL, actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(article_id,article_version) REFERENCES article_versions(article_id,version)
);
CREATE INDEX article_quality_reviews_run_idx ON article_quality_reviews(run_id,created_at DESC,id DESC);
CREATE INDEX article_editorial_reviews_article_idx ON article_editorial_reviews(article_id,created_at DESC,id DESC);
ALTER TABLE optimization_articles ADD COLUMN deleted_at timestamptz;

CREATE FUNCTION geo_article_snapshot(row_data optimization_articles) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('articleId',row_data.id,'projectId',row_data.project_id,'organizationId',row_data.organization_id,
 'version',row_data.version,'title',row_data.title,'summary',row_data.summary,'contentMarkdown',row_data.content_markdown,
 'publicationPlan',row_data.publication_plan,'evidenceIds',row_data.evidence_ids,'targetPromptIds',row_data.target_prompt_ids,
 'factGaps',row_data.fact_gaps)
$$;
INSERT INTO article_versions(id,article_id,project_id,organization_id,version,snapshot)
 SELECT id||':'||version,id,project_id,organization_id,version,geo_article_snapshot(a) FROM optimization_articles a;

CREATE FUNCTION geo_article_version_before() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'article_deleted'; END IF;
 IF (geo_article_snapshot(NEW)-'version') IS DISTINCT FROM (geo_article_snapshot(OLD)-'version') OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id THEN
  NEW.version=OLD.version+1;
  NEW.status='draft';
 ELSE NEW.version=OLD.version; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER article_version_before BEFORE UPDATE ON optimization_articles FOR EACH ROW EXECUTE FUNCTION geo_article_version_before();
CREATE FUNCTION geo_article_version_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO article_versions(id,article_id,project_id,organization_id,version,snapshot)
 VALUES(NEW.id||':'||NEW.version,NEW.id,NEW.project_id,NEW.organization_id,NEW.version,geo_article_snapshot(NEW)) ON CONFLICT(article_id,version) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER article_version_after AFTER INSERT OR UPDATE ON optimization_articles FOR EACH ROW EXECUTE FUNCTION geo_article_version_after();

CREATE FUNCTION geo_article_quality_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','selected_attempt_id','error_message','updated_at','completed_at']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','selected_attempt_id','error_message','updated_at','completed_at']) THEN
  RAISE EXCEPTION 'article_quality_input_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER article_quality_frozen BEFORE UPDATE OR DELETE ON article_quality_runs FOR EACH ROW EXECUTE FUNCTION geo_article_quality_frozen();

CREATE FUNCTION geo_article_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'article_history_immutable'; END $$;
DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['article_versions','article_quality_attempts','article_quality_reviews','article_editorial_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER article_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_article_immutable()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['article_versions','article_quality_runs','article_quality_attempts','article_quality_reviews','article_editorial_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row()',table_name);
 END LOOP;
END $$;
