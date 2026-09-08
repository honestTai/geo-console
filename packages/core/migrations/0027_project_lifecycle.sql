ALTER TABLE projects ADD COLUMN archived_at timestamptz;
ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
UPDATE projects SET archived_at=updated_at WHERE status='archived';
CREATE INDEX projects_visible_idx ON projects(organization_id,updated_at DESC) WHERE deleted_at IS NULL;

INSERT INTO permissions(key,kind,group_label,label,parent_key,position,built_in)
VALUES ('project.archive','action','客户与建档','封档客户','page.customers',91,true),
 ('project.delete','action','客户与建档','删除客户','page.customers',92,true);
-- New permissions require an explicit organization/role grant.
INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,all_of,resource_type,resource_param,scope,built_in)
VALUES ('http:project-archive','POST /api/projects/:projectId/archive','http','封档客户','POST','/api/projects/:projectId/archive','["project.archive"]','project','projectId','project',true),
 ('http:project-delete','DELETE /api/projects/:projectId','http','删除客户','DELETE','/api/projects/:projectId','["project.delete"]','project','projectId','project',true);

-- Serialize writes with lifecycle transitions, including work authorized before the transition.
CREATE FUNCTION geo_project_writable(target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE project_state projects%ROWTYPE;
BEGIN
 IF target IS NULL THEN RETURN; END IF;
 SELECT * INTO project_state FROM projects WHERE id=target FOR SHARE;
 IF NOT FOUND OR project_state.deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'project_deleted' USING ERRCODE='PZ002';
 END IF;
 IF project_state.status='archived' THEN
  RAISE EXCEPTION 'project_archived' USING ERRCODE='PZ001';
 END IF;
END $$;

CREATE FUNCTION geo_job_project(payload jsonb) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE(payload->>'projectId',
  (SELECT project_id FROM agent_runs WHERE id=payload->>'runId'),
  (SELECT project_id FROM semantic_parse_runs WHERE id=payload->>'runId'),
  (SELECT project_id FROM agent_sessions WHERE id=payload->>'sessionId'),
  (SELECT project_id FROM report_snapshots WHERE id=payload->>'reportId'),
  (SELECT project_id FROM answer_analysis_runs WHERE id=payload->>'analysisId'))
$$;

CREATE FUNCTION geo_guard_project_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; target text; old_target text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  row_data=to_jsonb(OLD);
  IF TG_TABLE_NAME='jobs' THEN old_target=geo_job_project(row_data->'payload');
  ELSIF TG_NARGS=0 THEN old_target=row_data->>'project_id';
  ELSE EXECUTE TG_ARGV[0] INTO old_target USING row_data; END IF;
  PERFORM geo_project_writable(old_target);
 END IF;
 IF TG_OP<>'DELETE' THEN
  row_data=to_jsonb(NEW);
  IF TG_TABLE_NAME='jobs' THEN target=geo_job_project(row_data->'payload');
  ELSIF TG_NARGS=0 THEN target=row_data->>'project_id';
  ELSE EXECUTE TG_ARGV[0] INTO target USING row_data; END IF;
  IF TG_OP='INSERT' OR target IS DISTINCT FROM old_target THEN PERFORM geo_project_writable(target); END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;

DO $$ DECLARE table_name text; entry record;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['competitors','prompts','website_snapshots','experiment_batches',
  'query_captures','diagnosis_findings','remediation_tasks','monitoring_schedules','attribution_imports',
  'attribution_events','agent_runs','report_snapshots','drift_alerts','project_costs','website_audits',
  'web_search_evidence','agent_sessions','optimization_articles','semantic_parse_runs','answer_analysis_runs','jobs']
 LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row()',table_name);
 END LOOP;
 FOR entry IN SELECT * FROM (VALUES
  ('agent_session_events','SELECT project_id FROM agent_sessions WHERE id=$1->>''session_id'''),
  ('desktop_agent_tool_calls','SELECT project_id FROM agent_sessions WHERE id=$1->>''session_id'''),
  ('report_shares','SELECT project_id FROM report_snapshots WHERE id=$1->>''report_id'''),
  ('semantic_observations','SELECT project_id FROM semantic_parse_runs WHERE id=$1->>''run_id'''),
  ('semantic_selections','SELECT project_id FROM semantic_parse_runs WHERE id=$1->>''run_id'''),
  ('metric_snapshots','SELECT project_id FROM semantic_parse_runs WHERE id=$1->>''run_id'''),
  ('answer_analysis_attempts','SELECT project_id FROM answer_analysis_runs WHERE id=$1->>''run_id'''),
  ('measurement_drift_observations','SELECT r.project_id FROM metric_snapshots m JOIN semantic_parse_runs r ON r.id=m.run_id WHERE m.id=$1->>''metric_id''')
 ) AS bindings(table_name,lookup)
 LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row(%L)',entry.table_name,entry.lookup);
 END LOOP;
END $$;

CREATE FUNCTION geo_guard_project_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'project_deleted' USING ERRCODE='PZ002';
 END IF;
 -- An archived project can only acquire its deletion marker; its historical profile stays intact.
 IF OLD.status='archived' AND NOT (NEW.deleted_at IS NOT NULL AND
  (to_jsonb(NEW)-'deleted_at'-'updated_at')=(to_jsonb(OLD)-'deleted_at'-'updated_at')) THEN
  RAISE EXCEPTION 'project_archived' USING ERRCODE='PZ001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER geo_project_state BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION geo_guard_project_state();
