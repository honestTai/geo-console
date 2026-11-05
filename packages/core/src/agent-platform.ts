import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./database";
import type { AgentAdapter, AgentRoutingMatch, AgentRoutingTarget, AgentTrustTier, DeclaredModel } from "./schema";

// Multi-agent platform core (docs/multi-agent-platform-design.md, slice P1a).
// The platform never chooses a model: `declaredModel` is self-reported by the agent and stored unverified.

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const MASTER_CAPABILITY = "orchestrate";
type ExecutionActorLike = { type: "user" | "system"; id: string };

export type RegisterAgentInput = {
	organizationId: string;
	name: string;
	adapter: AgentAdapter;
	command: string[];
	capabilities: string[];
	declaredModel?: DeclaredModel | null;
	trustTier: AgentTrustTier;
	createdBy?: string | null;
};

export async function registerAgent(database: Database, input: RegisterAgentInput): Promise<string> {
	if (!input.name.trim()) throw new Error("agent_name_required");
	if (input.adapter !== "builtin" && input.command.length === 0) throw new Error("agent_command_required");
	const id = randomUUID();
	await database.transaction(async (tx) => {
		await tx.query(
			`INSERT INTO agents (id,organization_id,name,adapter,command,capabilities,declared_model,trust_tier,created_by)
			 VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
			[
				id,
				input.organizationId,
				input.name.trim(),
				input.adapter,
				JSON.stringify(input.command),
				JSON.stringify([...new Set(input.capabilities)].sort()),
				input.declaredModel ? JSON.stringify(input.declaredModel) : null,
				input.trustTier,
				input.createdBy ?? null,
			],
		);
		await snapshotAgent(tx, id, { type: "user", id: input.createdBy ?? "system" });
	});
	return id;
}

async function snapshotAgent(tx: Pick<Database, "query">, agentId: string, actor: ExecutionActorLike): Promise<void> {
	await tx.query(
		`INSERT INTO agent_versions (id,agent_id,revision,snapshot,actor)
		 SELECT $1,id,revision,to_jsonb(agents)-'created_at'-'updated_at',$2::jsonb FROM agents WHERE id=$3`,
		[randomUUID(), JSON.stringify(actor), agentId],
	);
}

/** Approval is a human action; the master agent can never approve agents. */
export async function approveAgent(database: Database, agentId: string, approvedBy: string): Promise<boolean> {
	return database.transaction(async (tx) => {
		const result = await tx.query(
			`UPDATE agents SET status='approved', approved_by=$2, approved_at=now(), revision=revision+1, updated_at=now()
			 WHERE id=$1 AND status='pending'`,
			[agentId, approvedBy],
		);
		if (result.affectedRows !== 1) return false;
		await snapshotAgent(tx, agentId, { type: "user", id: approvedBy });
		return true;
	});
}

export async function disableAgent(database: Database, agentId: string, actorId: string): Promise<boolean> {
	return database.transaction(async (tx) => {
		const result = await tx.query(
			`UPDATE agents SET status='disabled', revision=revision+1, updated_at=now() WHERE id=$1 AND status<>'disabled'`,
			[agentId],
		);
		if (result.affectedRows !== 1) return false;
		await tx.query(
			`UPDATE org_agent_settings SET master_agent_id=NULL, updated_by=$2, updated_at=now() WHERE master_agent_id=$1`,
			[agentId, actorId],
		);
		await snapshotAgent(tx, agentId, { type: "user", id: actorId });
		return true;
	});
}

/** The master agent is a setting. It must be approved, in the same organization, and declare `orchestrate`. */
export async function setMasterAgent(
	database: Database,
	organizationId: string,
	agentId: string | null,
	updatedBy: string,
): Promise<void> {
	await database.transaction(async (tx) => {
		if (agentId !== null) {
			const agent = (
				await tx.query<{ status: string; capabilities: string[] }>(
					"SELECT status,capabilities FROM agents WHERE id=$1 AND organization_id=$2",
					[agentId, organizationId],
				)
			).rows[0];
			if (!agent) throw new Error("master_agent_not_found");
			if (agent.status !== "approved") throw new Error("master_agent_not_approved");
			if (!agent.capabilities.includes(MASTER_CAPABILITY)) throw new Error("master_agent_missing_orchestrate");
		}
		await tx.query(
			`INSERT INTO org_agent_settings (organization_id,master_agent_id,updated_by,updated_at) VALUES ($1,$2,$3,now())
			 ON CONFLICT (organization_id) DO UPDATE SET master_agent_id=EXCLUDED.master_agent_id,
			 updated_by=EXCLUDED.updated_by, updated_at=now()`,
			[organizationId, agentId, updatedBy],
		);
	});
}

export type RunnerRecord = { id: string; organizationId: string; agentIds: string[]; maxConcurrency: number };

/** The plaintext token is returned once; only its hash is stored. */
export async function createRunner(
	database: Database,
	input: {
		organizationId: string;
		name: string;
		agentIds: string[];
		maxConcurrency?: number;
		createdBy?: string | null;
	},
): Promise<{ id: string; token: string }> {
	const approved = await database.query<{ id: string }>(
		"SELECT id FROM agents WHERE organization_id=$1 AND status='approved' AND id=ANY($2::text[])",
		[input.organizationId, input.agentIds],
	);
	if (approved.rows.length !== new Set(input.agentIds).size) throw new Error("runner_agents_not_approved");
	const id = randomUUID();
	const token = randomBytes(32).toString("base64url");
	await database.query(
		`INSERT INTO runners (id,organization_id,name,token_hash,agent_ids,max_concurrency,created_by)
		 VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
		[
			id,
			input.organizationId,
			input.name.trim(),
			sha256(token),
			JSON.stringify([...new Set(input.agentIds)].sort()),
			input.maxConcurrency ?? 1,
			input.createdBy ?? null,
		],
	);
	return { id, token };
}

export async function authenticateRunner(database: Database, token: string): Promise<RunnerRecord | null> {
	const row = (
		await database.query<{ id: string; organization_id: string; agent_ids: string[]; max_concurrency: number }>(
			`UPDATE runners SET last_seen_at=now()
			 WHERE token_hash=$1 AND status='active'
			 AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=runners.organization_id AND o.suspended_at IS NULL)
			 RETURNING id,organization_id,agent_ids,max_concurrency`,
			[sha256(token)],
		)
	).rows[0];
	return row
		? { id: row.id, organizationId: row.organization_id, agentIds: row.agent_ids, maxConcurrency: row.max_concurrency }
		: null;
}

export async function revokeRunner(database: Database, runnerId: string): Promise<boolean> {
	const result = await database.query(
		"UPDATE runners SET status='revoked', revoked_at=now() WHERE id=$1 AND status='active'",
		[runnerId],
	);
	return result.affectedRows === 1;
}

export type IncomingEvent = {
	organizationId: string;
	projectId?: string | null;
	source: string;
	type: string;
	subject?: { kind?: string; id?: string } & Record<string, unknown>;
	summary?: string;
	link?: string | null;
	dedupeKey: string;
};

/** Duplicate deliveries are common. `(organization, source, dedupeKey)` is unique. */
export async function ingestEvent(
	database: Database,
	event: IncomingEvent,
): Promise<{ id: string; duplicate: boolean }> {
	const id = randomUUID();
	const inserted = await database.query<{ id: string }>(
		`INSERT INTO event_inbox (id,organization_id,project_id,source,type,subject,summary,link,dedupe_key)
		 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
		 ON CONFLICT (organization_id,source,dedupe_key) DO NOTHING RETURNING id`,
		[
			id,
			event.organizationId,
			event.projectId ?? null,
			event.source,
			event.type,
			JSON.stringify(event.subject ?? {}),
			(event.summary ?? "").slice(0, 500),
			event.link ?? null,
			event.dedupeKey,
		],
	);
	if (inserted.rows[0]) return { id, duplicate: false };
	const existing = await database.query<{ id: string }>(
		"SELECT id FROM event_inbox WHERE organization_id=$1 AND source=$2 AND dedupe_key=$3",
		[event.organizationId, event.source, event.dedupeKey],
	);
	return { id: existing.rows[0].id, duplicate: true };
}

export type RoutingRuleInput = {
	organizationId: string;
	ruleKey: string;
	enabled?: boolean;
	match: AgentRoutingMatch;
	target: AgentRoutingTarget;
	groupKey?: string | null;
	parallel?: number;
	tell?: "needed" | "always" | "never";
	createdBy?: string | null;
};

/** Rules are immutable. Editing creates the next version; the highest enabled version is active. */
export async function addRoutingRuleVersion(database: Database, input: RoutingRuleInput): Promise<number> {
	return database.transaction(async (tx) => {
		const next = (
			await tx.query<{ version: number }>(
				"SELECT COALESCE(MAX(version),0)+1 AS version FROM routing_rules WHERE organization_id=$1 AND rule_key=$2",
				[input.organizationId, input.ruleKey],
			)
		).rows[0].version;
		await tx.query(
			`INSERT INTO routing_rules (id,organization_id,rule_key,version,enabled,match,target,group_key,parallel,tell,created_by)
			 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
			[
				randomUUID(),
				input.organizationId,
				input.ruleKey,
				next,
				input.enabled ?? true,
				JSON.stringify(input.match),
				JSON.stringify(input.target),
				input.groupKey ?? null,
				input.parallel ?? 1,
				input.tell ?? "needed",
				input.createdBy ?? null,
			],
		);
		return next;
	});
}

export type RouteResult = { status: "routed" | "ignored"; taskIds: string[]; mergedTaskIds: string[] };

type Tx = Pick<Database, "query">;
type StoredEvent = {
	id: string;
	organization_id: string;
	project_id: string | null;
	source: string;
	type: string;
	subject: { kind?: string; id?: string };
	summary: string;
	link: string | null;
	status: string;
};
type ActiveRule = {
	rule_key: string;
	version: number;
	enabled: boolean;
	match: AgentRoutingMatch;
	target: AgentRoutingTarget;
	group_key: string | null;
	parallel: number;
};

/** The active version of a rule key is its highest version; a disabled latest version stops routing. */
async function activeRules(tx: Tx, organizationId: string): Promise<ActiveRule[]> {
	const rows = (
		await tx.query<ActiveRule>(
			`SELECT DISTINCT ON (rule_key) rule_key,version,enabled,match,target,group_key,parallel
			 FROM routing_rules WHERE organization_id=$1 ORDER BY rule_key,version DESC`,
			[organizationId],
		)
	).rows;
	return rows.filter((rule) => rule.enabled);
}

const ruleMatches = (rule: ActiveRule, event: StoredEvent) =>
	rule.match.source === event.source &&
	rule.match.types.includes(event.type) &&
	(!rule.match.projectId || rule.match.projectId === event.project_id);

/** Creates a task for the event, or merges it into a still-pending task for the same object and rule. */
async function createOrMergeTask(
	tx: Tx,
	event: StoredEvent,
	rule: ActiveRule,
): Promise<{ taskId: string; merged: boolean }> {
	const groupKey = rule.group_key ? `${rule.group_key}:${event.subject?.kind ?? ""}:${event.subject?.id ?? ""}` : null;
	if (groupKey) {
		const existing = (
			await tx.query<{ id: string }>(
				`SELECT id FROM agent_tasks WHERE organization_id=$1 AND group_key=$2 AND rule_key=$3 AND status='pending' FOR UPDATE`,
				[event.organization_id, groupKey, rule.rule_key],
			)
		).rows[0];
		if (existing) {
			await tx.query("UPDATE agent_tasks SET event_ids=event_ids||$2::jsonb, updated_at=now() WHERE id=$1", [
				existing.id,
				JSON.stringify([event.id]),
			]);
			return { taskId: existing.id, merged: true };
		}
	}
	const taskId = randomUUID();
	await tx.query(
		`INSERT INTO agent_tasks (id,organization_id,project_id,rule_key,rule_version,event_ids,capability,skill,agent_id,input,group_key,group_parallel)
		 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12)`,
		[
			taskId,
			event.organization_id,
			event.project_id,
			rule.rule_key,
			rule.version,
			JSON.stringify([event.id]),
			rule.target.capability,
			rule.target.skill ?? null,
			rule.target.agentId ?? null,
			JSON.stringify({ subject: event.subject, summary: event.summary, link: event.link, type: event.type }),
			groupKey,
			rule.parallel,
		],
	);
	return { taskId, merged: false };
}

/**
 * Matches the event against the active rule versions. Events for the same object (same group key) that arrive
 * while a task is still pending are merged into that task instead of creating a second one.
 */
export async function routeEvent(database: Database, eventId: string): Promise<RouteResult> {
	return database.transaction(async (tx) => {
		const event = (await tx.query<StoredEvent>("SELECT * FROM event_inbox WHERE id=$1 FOR UPDATE", [eventId])).rows[0];
		if (!event) throw new Error("event_not_found");
		if (event.status !== "new") return { status: "ignored", taskIds: [], mergedTaskIds: [] };
		const taskIds: string[] = [];
		const mergedTaskIds: string[] = [];
		for (const rule of (await activeRules(tx, event.organization_id)).filter((candidate) =>
			ruleMatches(candidate, event),
		)) {
			const { taskId, merged } = await createOrMergeTask(tx, event, rule);
			(merged ? mergedTaskIds : taskIds).push(taskId);
		}
		const routed = taskIds.length + mergedTaskIds.length > 0;
		await tx.query("UPDATE event_inbox SET status=$2, route_note=$3, routed_at=now() WHERE id=$1", [
			event.id,
			routed ? "routed" : "ignored",
			routed ? null : "no_matching_rule",
		]);
		return { status: routed ? "routed" : "ignored", taskIds, mergedTaskIds };
	});
}

export type ClaimedAgentTask = {
	taskId: string;
	runId: string;
	attempt: number;
	capability: string;
	skill: string | null;
	agentId: string;
	input: Record<string, unknown>;
	projectId: string | null;
	organizationId: string;
	leaseExpiresAt: string;
};

/**
 * Leases the oldest runnable task for this runner. Expired leases are reclaimable, so a crashed or
 * offline runner can never strand a task. Claims are serialized per organization.
 */
export async function claimAgentTask(
	database: Database,
	runnerId: string,
	leaseSeconds = 300,
): Promise<ClaimedAgentTask | null> {
	return database.transaction(async (tx) => {
		const runner = (
			await tx.query<{ organization_id: string; agent_ids: string[]; max_concurrency: number }>(
				"SELECT organization_id,agent_ids,max_concurrency FROM runners WHERE id=$1 AND status='active'",
				[runnerId],
			)
		).rows[0];
		if (!runner) return null;
		await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent_tasks:${runner.organization_id}`]);
		const busy = (
			await tx.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM agent_tasks WHERE lease_owner=$1 AND status='leased' AND lease_expires_at>now()`,
				[runnerId],
			)
		).rows[0].n;
		if (busy >= runner.max_concurrency) return null;
		const agents = (
			await tx.query<{ id: string; capabilities: string[] }>(
				`SELECT id,capabilities FROM agents WHERE organization_id=$1 AND status='approved' AND id=ANY($2::text[]) ORDER BY id`,
				[runner.organization_id, runner.agent_ids],
			)
		).rows;
		const capabilities = [...new Set(agents.flatMap((agent) => agent.capabilities))];
		if (!capabilities.length) return null;
		const task = (
			await tx.query<{
				id: string;
				attempts: number;
				capability: string;
				skill: string | null;
				agent_id: string | null;
				input: Record<string, unknown>;
				project_id: string | null;
			}>(
				`SELECT t.id,t.attempts,t.capability,t.skill,t.agent_id,t.input,t.project_id FROM agent_tasks t
				 WHERE t.organization_id=$1 AND t.attempts<t.max_attempts AND t.available_at<=now()
				 AND (t.status='pending' OR (t.status='leased' AND t.lease_expires_at<now()))
				 AND t.capability=ANY($2::text[]) AND (t.agent_id IS NULL OR t.agent_id=ANY($3::text[]))
				 AND (t.group_key IS NULL OR (SELECT count(*) FROM agent_tasks g
				   WHERE g.organization_id=t.organization_id AND g.group_key=t.group_key AND g.id<>t.id
				   AND g.status='leased' AND g.lease_expires_at>now()) < t.group_parallel)
				 AND EXISTS(SELECT 1 FROM organizations o WHERE o.id=t.organization_id AND o.suspended_at IS NULL)
				 ORDER BY t.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
				[runner.organization_id, capabilities, agents.map((agent) => agent.id)],
			)
		).rows[0];
		if (!task) return null;
		const agent =
			agents.find((candidate) => candidate.id === task.agent_id) ??
			agents.find((candidate) => candidate.capabilities.includes(task.capability));
		if (!agent) return null;
		const attempt = task.attempts + 1;
		await tx.query(
			`UPDATE agent_task_runs SET status='expired', finished_at=now(), error=COALESCE(error,'lease_expired')
			 WHERE task_id=$1 AND status='running'`,
			[task.id],
		);
		const leased = (
			await tx.query<{ lease_expires_at: string }>(
				`UPDATE agent_tasks SET status='leased', lease_owner=$2, attempts=$3,
				 lease_expires_at=now()+($4*interval '1 second'), updated_at=now()
				 WHERE id=$1 RETURNING lease_expires_at`,
				[task.id, runnerId, attempt, leaseSeconds],
			)
		).rows[0];
		const runId = randomUUID();
		await tx.query(
			`INSERT INTO agent_task_runs (id,task_id,organization_id,project_id,runner_id,agent_id,attempt)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			[runId, task.id, runner.organization_id, task.project_id, runnerId, agent.id, attempt],
		);
		return {
			taskId: task.id,
			runId,
			attempt,
			capability: task.capability,
			skill: task.skill,
			agentId: agent.id,
			input: task.input,
			projectId: task.project_id,
			organizationId: runner.organization_id,
			leaseExpiresAt: leased.lease_expires_at,
		};
	});
}

export async function renewAgentTaskLease(
	database: Database,
	taskId: string,
	runnerId: string,
	leaseSeconds = 300,
): Promise<boolean> {
	const result = await database.query(
		`UPDATE agent_tasks SET lease_expires_at=now()+($3*interval '1 second'), updated_at=now()
		 WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()`,
		[taskId, runnerId, leaseSeconds],
	);
	return result.affectedRows === 1;
}

/** Idempotent: a second completion, or one from a runner that lost the lease, returns false and writes nothing. */
export async function completeAgentTask(
	database: Database,
	taskId: string,
	runnerId: string,
	outcome: { output: unknown; reportedUsage?: Record<string, unknown> | null },
): Promise<boolean> {
	return database.transaction(async (tx) => {
		const updated = await tx.query(
			`UPDATE agent_tasks SET status='complete', result=$3::jsonb, lease_owner=NULL, lease_expires_at=NULL,
			 completed_at=now(), updated_at=now()
			 WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()`,
			[taskId, runnerId, JSON.stringify(outcome.output ?? null)],
		);
		if (updated.affectedRows !== 1) return false;
		await tx.query(
			`UPDATE agent_task_runs SET status='complete', output=$3::jsonb, reported_usage=$4::jsonb, finished_at=now()
			 WHERE task_id=$1 AND runner_id=$2 AND status='running'`,
			[
				taskId,
				runnerId,
				JSON.stringify(outcome.output ?? null),
				outcome.reportedUsage ? JSON.stringify(outcome.reportedUsage) : null,
			],
		);
		return true;
	});
}

export async function failAgentTask(
	database: Database,
	taskId: string,
	runnerId: string,
	message: string,
): Promise<boolean> {
	return database.transaction(async (tx) => {
		const updated = await tx.query(
			`UPDATE agent_tasks SET
			 status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
			 lease_owner=NULL, lease_expires_at=NULL, last_error=$3,
			 available_at=now()+interval '30 seconds', updated_at=now(),
			 completed_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END
			 WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
			[taskId, runnerId, message.slice(0, 2000)],
		);
		if (updated.affectedRows !== 1) return false;
		await tx.query(
			`UPDATE agent_task_runs SET status='failed', error=$3, finished_at=now()
			 WHERE task_id=$1 AND runner_id=$2 AND status='running'`,
			[taskId, runnerId, message.slice(0, 2000)],
		);
		return true;
	});
}

/** Tasks whose lease expired with no attempts left can never be claimed again, so they must converge to failed. */
export async function sweepExpiredAgentTasks(database: Database): Promise<number> {
	return database.transaction(async (tx) => {
		const failed = await tx.query<{ id: string }>(
			`UPDATE agent_tasks SET status='failed', lease_owner=NULL, lease_expires_at=NULL,
			 last_error=COALESCE(last_error,'runner_lost: lease expired with no attempts left'),
			 completed_at=now(), updated_at=now()
			 WHERE status='leased' AND lease_expires_at<now() AND attempts>=max_attempts RETURNING id`,
		);
		if (failed.rows.length)
			await tx.query(
				`UPDATE agent_task_runs SET status='expired', finished_at=now(), error=COALESCE(error,'lease_expired')
				 WHERE task_id=ANY($1::text[]) AND status='running'`,
				[failed.rows.map((row) => row.id)],
			);
		return failed.rows.length;
	});
}
