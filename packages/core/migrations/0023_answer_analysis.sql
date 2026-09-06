-- Supplemental, on-demand interpretation. Never changes captures, measurement contracts or ranking snapshots.
CREATE TABLE answer_analysis_runs (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizations(id),
 project_id text NOT NULL REFERENCES projects(id),
 batch_id text NOT NULL REFERENCES experiment_batches(id),
 capture_id text NOT NULL REFERENCES query_captures(id),
 contract jsonb NOT NULL,
 contract_hash text NOT NULL,
 input_hash text NOT NULL,
 execution_actor jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','needs_review','failed')),
 selected_attempt_id text,
 error_message text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
CREATE INDEX answer_analysis_capture_idx ON answer_analysis_runs(capture_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX answer_analysis_active_idx ON answer_analysis_runs(capture_id) WHERE status IN ('queued','running');
CREATE TABLE answer_analysis_attempts (
 id text PRIMARY KEY,
 run_id text NOT NULL REFERENCES answer_analysis_runs(id),
 attempt integer NOT NULL CHECK(attempt > 0),
 status text NOT NULL CHECK(status IN ('valid','needs_review','failed')),
 result jsonb,
 validation jsonb NOT NULL,
 raw_response jsonb NOT NULL,
 usage jsonb,
 cost_micros bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,attempt)
);
ALTER TABLE answer_analysis_runs ADD CONSTRAINT answer_analysis_selected_attempt_fk FOREIGN KEY(selected_attempt_id) REFERENCES answer_analysis_attempts(id);
CREATE UNIQUE INDEX answer_analysis_job_key ON jobs((payload->>'analysisId')) WHERE type='answer_analysis';

INSERT INTO authorization_policies(id,policy_key,kind,label,http_method,path_pattern,all_of,resource_type,resource_param,scope,built_in)
VALUES
 ('http:answer-analysis:get','GET /api/batches/:batchId/captures/:captureId/analysis','http','读取回答完整语义分析','GET','/api/batches/:batchId/captures/:captureId/analysis','["page.evidence"]','batch','batchId','project',true),
 ('http:answer-analysis:post','POST /api/batches/:batchId/captures/:captureId/analysis','http','生成回答完整语义分析','POST','/api/batches/:batchId/captures/:captureId/analysis','["page.evidence","agent.run"]','batch','batchId','project',true);
INSERT INTO authorization_policies(id,policy_key,kind,label,all_of,resource_type,scope,built_in)
VALUES ('execution:answer-analysis','answer.analysis.execute','execution','执行回答完整语义分析','["page.evidence","agent.run"]','project','project',true);
