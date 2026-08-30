ALTER TABLE project_costs ALTER COLUMN cost_micros DROP NOT NULL;
ALTER TABLE project_costs ALTER COLUMN cost_micros DROP DEFAULT;
