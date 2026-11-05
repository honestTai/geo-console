-- Multi-agent platform core (design: docs/multi-agent-platform-design.md, slice P1a).
-- Additive only: no existing table, evidence row or object is changed.
-- Organization is the only isolation boundary (no multi-tenant extras); project_id is optional scoping inside it.

CREATE TABLE agents (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL,
 adapter text NOT NULL CHECK(adapter IN ('acp','cli-exec','builtin')),
 command jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(command)='array'),
 capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(capabilities)='array'),
 declared_model jsonb,
 trust_tier text NOT NULL CHECK(trust_tier IN ('T1','T2')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','disabled')),
 revision integer NOT NULL DEFAULT 1,
 created_by text REFERENCES users(id), approved_by text REFERENCES users(id), approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,name)
);
CREATE TABLE agent_versions (
 id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agents(id), revision integer NOT NULL,
 snapshot jsonb NOT NULL, actor jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(agent_id,revision)
);
CREATE TABLE org_agent_settings (
 organization_id text PRIMARY KEY REFERENCES organizations(id),
 master_agent_id text REFERENCES agents(id),
 updated_by text REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runners (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 name text NOT NULL, token_hash text NOT NULL UNIQUE,
 agent_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(agent_ids)='array'),
 max_concurrency integer NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 1 AND 16),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 last_seen_at timestamptz, created_by text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 UNIQUE(organization_id,name)
);

CREATE TABLE event_inbox (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), project_id text REFERENCES projects(id),
 source text NOT NULL, type text NOT NULL, subject jsonb NOT NULL DEFAULT '{}'::jsonb, summary text NOT NULL DEFAULT '',
 link text, dedupe_key text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','routed','ignored','failed')),
 route_note text, received_at timestamptz NOT NULL DEFAULT now(), routed_at timestamptz,
 UNIQUE(organization_id,source,dedupe_key)
);
CREATE INDEX event_inbox_status_idx ON event_inbox(organization_id,status,received_at);

-- Rules are immutable versions. The active rule for a rule_key is its highest version, if enabled.
CREATE TABLE routing_rules (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
 rule_key text NOT NULL, version integer NOT NULL, enabled boolean NOT NULL DEFAULT true,
 match jsonb NOT NULL, target jsonb NOT NULL,
 group_key text, parallel integer NOT NULL DEFAULT 1 CHECK(parallel BETWEEN 1 AND 16),
 tell text NOT NULL DEFAULT 'needed' CHECK(tell IN ('needed','always','never')),
 created_by text REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,rule_key,version)
);

CREATE TABLE agent_tasks (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), project_id text REFERENCES projects(id),
 rule_key text, rule_version integer,
 event_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(event_ids)='array'),
 capability text NOT NULL, skill text, agent_id text REFERENCES agents(id),
 input jsonb NOT NULL DEFAULT '{}'::jsonb,
 group_key text, group_parallel integer NOT NULL DEFAULT 1 CHECK(group_parallel BETWEEN 1 AND 16),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','complete','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 10),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner text REFERENCES runners(id), lease_expires_at timestamptz,
 result jsonb, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX agent_tasks_claim_idx ON agent_tasks(organization_id,status,available_at,lease_expires_at);
CREATE INDEX agent_tasks_group_idx ON agent_tasks(organization_id,group_key) WHERE group_key IS NOT NULL;

CREATE TABLE agent_task_runs (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES agent_tasks(id),
 organization_id text NOT NULL REFERENCES organizations(id), project_id text REFERENCES projects(id),
 runner_id text NOT NULL REFERENCES runners(id), agent_id text REFERENCES agents(id),
 attempt integer NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','failed','expired')),
 output jsonb, error text,
 reported_usage jsonb, -- self-reported by the agent; null means unknown, never estimated
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(task_id,attempt)
);
CREATE INDEX agent_task_runs_task_idx ON agent_task_runs(task_id,attempt);

CREATE FUNCTION geo_agent_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'agent_history_immutable'; END $$;

DO $$ DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['agent_versions','routing_rules'] LOOP
  EXECUTE format('CREATE TRIGGER agent_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_agent_history_immutable()',table_name);
 END LOOP;
 -- Archived or deleted projects are read-only for every project-scoped agent table.
 FOREACH table_name IN ARRAY ARRAY['event_inbox','agent_tasks','agent_task_runs'] LOOP
  EXECUTE format('CREATE TRIGGER geo_project_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION geo_guard_project_row()',table_name);
 END LOOP;
END $$;
