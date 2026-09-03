-- 周期监测失败可见、整改任务审计验收。

ALTER TABLE monitoring_schedules ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE monitoring_schedules ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
ALTER TABLE monitoring_schedules ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0;

ALTER TABLE remediation_tasks ADD COLUMN IF NOT EXISTS verified_audit_id text REFERENCES website_audits(id);
