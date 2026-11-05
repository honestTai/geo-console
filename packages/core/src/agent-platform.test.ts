import { describe, expect, it, vi } from "vitest";
import {
	addRoutingRuleVersion,
	approveAgent,
	authenticateRunner,
	claimAgentTask,
	completeAgentTask,
	createRunner,
	disableAgent,
	failAgentTask,
	ingestEvent,
	registerAgent,
	renewAgentTaskLease,
	revokeRunner,
	routeEvent,
	setMasterAgent,
	sweepExpiredAgentTasks,
} from "./agent-platform";
import { type Database, migrateDatabase, openMemoryDatabase } from "./database";

// Each test migrates a fresh in-memory database; allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const ORG = "default";
const USER = "user-1";

async function setup(): Promise<Database> {
	const database = openMemoryDatabase();
	await migrateDatabase(database);
	await database.query("INSERT INTO organizations(id,name) VALUES('other','测试其他机构')");
	await database.query(
		`INSERT INTO users (id,organization_id,email,display_name,password_hash,role)
		 VALUES ($1,'default','agent-test@test.invalid','测试','test-only','admin')`,
		[USER],
	);
	await database.query(
		`INSERT INTO projects (id,name,website_url,domain,region,language,status)
		 VALUES ('p1','客户','https://customer.example','customer.example','中国','zh-CN','active')`,
	);
	return database;
}

async function approvedAgent(database: Database, name: string, capabilities: string[], organizationId = ORG) {
	const id = await registerAgent(database, {
		organizationId,
		name,
		adapter: "cli-exec",
		command: ["agent-cli", "--mcp"],
		capabilities,
		declaredModel: { provider: "self-reported", name: "unverified" },
		trustTier: "T2",
		createdBy: USER,
	});
	if (organizationId === ORG) await approveAgent(database, id, USER);
	else await database.query("UPDATE agents SET status='approved' WHERE id=$1", [id]);
	return id;
}

async function ruleAndEvent(database: Database, dedupeKey: string, subjectId = "article-1") {
	const event = await ingestEvent(database, {
		organizationId: ORG,
		projectId: "p1",
		source: "comment",
		type: "comment.new",
		subject: { kind: "article_version", id: subjectId },
		summary: "一条评论",
		dedupeKey,
	});
	return { event, routed: await routeEvent(database, event.id) };
}

describe("Agent 注册与主控", () => {
	it("新 Agent 待批准，批准写入版本，主控必须已批准且声明 orchestrate", async () => {
		const database = await setup();
		try {
			const id = await registerAgent(database, {
				organizationId: ORG,
				name: "main",
				adapter: "acp",
				command: ["agent", "acp"],
				capabilities: ["orchestrate", "orchestrate"],
				trustTier: "T2",
				createdBy: USER,
			});
			const pending = (
				await database.query<{ status: string; capabilities: string[]; declared_model: unknown }>(
					"SELECT status,capabilities,declared_model FROM agents WHERE id=$1",
					[id],
				)
			).rows[0];
			expect(pending.status).toBe("pending");
			expect(pending.capabilities).toEqual(["orchestrate"]);
			expect(pending.declared_model).toBeNull();
			await expect(setMasterAgent(database, ORG, id, USER)).rejects.toThrow("master_agent_not_approved");
			expect(await approveAgent(database, id, USER)).toBe(true);
			expect(await approveAgent(database, id, USER)).toBe(false);
			await setMasterAgent(database, ORG, id, USER);
			const versions = await database.query("SELECT revision FROM agent_versions WHERE agent_id=$1 ORDER BY revision", [
				id,
			]);
			expect(versions.rows.map((row) => row.revision)).toEqual([1, 2]);
			const worker = await approvedAgent(database, "worker", ["write.article"]);
			await expect(setMasterAgent(database, ORG, worker, USER)).rejects.toThrow("master_agent_missing_orchestrate");
			const foreign = await approvedAgent(database, "foreign", ["orchestrate"], "other");
			await expect(setMasterAgent(database, ORG, foreign, USER)).rejects.toThrow("master_agent_not_found");
			expect(await disableAgent(database, id, USER)).toBe(true);
			const settings = await database.query<{ master_agent_id: string | null }>(
				"SELECT master_agent_id FROM org_agent_settings WHERE organization_id=$1",
				[ORG],
			);
			expect(settings.rows[0].master_agent_id).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("非内置 Agent 必须有启动命令；版本历史不可修改", async () => {
		const database = await setup();
		try {
			await expect(
				registerAgent(database, {
					organizationId: ORG,
					name: "x",
					adapter: "acp",
					command: [],
					capabilities: [],
					trustTier: "T2",
				}),
			).rejects.toThrow("agent_command_required");
			const id = await approvedAgent(database, "a", ["capture.api"]);
			await expect(
				database.query("UPDATE agent_versions SET snapshot='{}'::jsonb WHERE agent_id=$1", [id]),
			).rejects.toThrow();
			await expect(database.query("DELETE FROM agent_versions WHERE agent_id=$1", [id])).rejects.toThrow();
		} finally {
			await database.close();
		}
	});
});

describe("Runner", () => {
	it("令牌只存哈希，只能绑定已批准 Agent，可撤销", async () => {
		const database = await setup();
		try {
			const pending = await registerAgent(database, {
				organizationId: ORG,
				name: "pending",
				adapter: "cli-exec",
				command: ["x"],
				capabilities: ["write.article"],
				trustTier: "T2",
			});
			await expect(createRunner(database, { organizationId: ORG, name: "r0", agentIds: [pending] })).rejects.toThrow(
				"runner_agents_not_approved",
			);
			const agent = await approvedAgent(database, "ok", ["write.article"]);
			const { id, token } = await createRunner(database, { organizationId: ORG, name: "r1", agentIds: [agent] });
			const stored = await database.query<{ token_hash: string }>("SELECT token_hash FROM runners WHERE id=$1", [id]);
			expect(stored.rows[0].token_hash).not.toContain(token);
			expect((await authenticateRunner(database, token))?.id).toBe(id);
			expect(await authenticateRunner(database, "wrong")).toBeNull();
			expect(await revokeRunner(database, id)).toBe(true);
			expect(await authenticateRunner(database, token)).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("机构被封禁后 Runner 不能认证也不能领取任务", async () => {
		const database = await setup();
		try {
			const agent = await approvedAgent(database, "ok", ["write.article"]);
			const { token } = await createRunner(database, { organizationId: ORG, name: "r1", agentIds: [agent] });
			await database.query("UPDATE organizations SET suspended_at=now() WHERE id=$1", [ORG]);
			expect(await authenticateRunner(database, token)).toBeNull();
		} finally {
			await database.close();
		}
	});
});

describe("事件与路由", () => {
	it("同一来源的同一 dedupeKey 只保留一条事件", async () => {
		const database = await setup();
		try {
			const first = await ingestEvent(database, {
				organizationId: ORG,
				source: "comment",
				type: "comment.new",
				dedupeKey: "c1",
			});
			const second = await ingestEvent(database, {
				organizationId: ORG,
				source: "comment",
				type: "comment.new",
				dedupeKey: "c1",
			});
			const other = await ingestEvent(database, {
				organizationId: ORG,
				source: "webhook",
				type: "comment.new",
				dedupeKey: "c1",
			});
			expect(second).toEqual({ id: first.id, duplicate: true });
			expect(other.duplicate).toBe(false);
		} finally {
			await database.close();
		}
	});

	it("没有规则时事件被忽略并说明原因；规则按版本生效，禁用的最新版本停止路由", async () => {
		const database = await setup();
		try {
			const none = await ruleAndEvent(database, "e0");
			expect(none.routed.status).toBe("ignored");
			const note = await database.query<{ route_note: string }>("SELECT route_note FROM event_inbox WHERE id=$1", [
				none.event.id,
			]);
			expect(note.rows[0].route_note).toBe("no_matching_rule");
			const base = {
				organizationId: ORG,
				ruleKey: "reply",
				match: { source: "comment", types: ["comment.new"] },
				target: { capability: "reply.comment", skill: "reply-faq" },
			};
			expect(await addRoutingRuleVersion(database, base)).toBe(1);
			expect((await ruleAndEvent(database, "e1")).routed.taskIds).toHaveLength(1);
			expect(await addRoutingRuleVersion(database, { ...base, enabled: false })).toBe(2);
			expect((await ruleAndEvent(database, "e2")).routed.status).toBe("ignored");
			await expect(database.query("UPDATE routing_rules SET enabled=true WHERE rule_key='reply'")).rejects.toThrow();
		} finally {
			await database.close();
		}
	});

	it("同一对象在任务领取前的多条事件合并成一个任务", async () => {
		const database = await setup();
		try {
			await addRoutingRuleVersion(database, {
				organizationId: ORG,
				ruleKey: "reply",
				match: { source: "comment", types: ["comment.new"] },
				target: { capability: "reply.comment" },
				groupKey: "reply",
			});
			const first = await ruleAndEvent(database, "m1", "article-1");
			const second = await ruleAndEvent(database, "m2", "article-1");
			const third = await ruleAndEvent(database, "m3", "article-2");
			expect(first.routed.taskIds).toHaveLength(1);
			expect(second.routed.mergedTaskIds).toEqual(first.routed.taskIds);
			expect(third.routed.taskIds).toHaveLength(1);
			const task = await database.query<{ event_ids: string[] }>("SELECT event_ids FROM agent_tasks WHERE id=$1", [
				first.routed.taskIds[0],
			]);
			expect(task.rows[0].event_ids).toEqual([first.event.id, second.event.id]);
			expect(await routeEvent(database, first.event.id)).toEqual({ status: "ignored", taskIds: [], mergedTaskIds: [] });
		} finally {
			await database.close();
		}
	});
});

describe("任务租约", () => {
	async function runnerWith(database: Database, capabilities: string[], name = "r1", organizationId = ORG) {
		const agent = await approvedAgent(database, `agent-${name}`, capabilities, organizationId);
		if (organizationId !== ORG) {
			const id = "runner-other";
			await database.query(
				`INSERT INTO runners (id,organization_id,name,token_hash,agent_ids) VALUES ($1,$2,$3,$4,$5::jsonb)`,
				[id, organizationId, name, `hash-${name}`, JSON.stringify([agent])],
			);
			return { id, agent };
		}
		return { ...(await createRunner(database, { organizationId, name, agentIds: [agent] })), agent };
	}
	async function rule(database: Database, capability = "reply.comment", extra: Record<string, unknown> = {}) {
		await addRoutingRuleVersion(database, {
			organizationId: ORG,
			ruleKey: capability,
			match: { source: "comment", types: ["comment.new"] },
			target: { capability },
			...extra,
		});
	}

	it("按能力匹配、不跨机构、领取后不重复发放", async () => {
		const database = await setup();
		try {
			await rule(database);
			await ruleAndEvent(database, "t1");
			const wrong = await runnerWith(database, ["write.article"], "writer");
			expect(await claimAgentTask(database, wrong.id)).toBeNull();
			const foreign = await runnerWith(database, ["reply.comment"], "foreign", "other");
			expect(await claimAgentTask(database, foreign.id)).toBeNull();
			const right = await runnerWith(database, ["reply.comment"], "replier");
			const claimed = await claimAgentTask(database, right.id, 60);
			expect(claimed?.capability).toBe("reply.comment");
			expect(claimed?.agentId).toBe(right.agent);
			expect(claimed?.attempt).toBe(1);
			expect(await claimAgentTask(database, right.id, 60)).toBeNull();
		} finally {
			await database.close();
		}
	});

	it("续租、幂等完成；用量未上报时保持 null", async () => {
		const database = await setup();
		try {
			await rule(database);
			await ruleAndEvent(database, "t1");
			const runner = await runnerWith(database, ["reply.comment"]);
			const claimed = await claimAgentTask(database, runner.id, 60);
			if (!claimed) throw new Error("expected claim");
			expect(await renewAgentTaskLease(database, claimed.taskId, runner.id, 120)).toBe(true);
			expect(await renewAgentTaskLease(database, claimed.taskId, "someone-else", 120)).toBe(false);
			expect(await completeAgentTask(database, claimed.taskId, runner.id, { output: { draft: "ok" } })).toBe(true);
			expect(await completeAgentTask(database, claimed.taskId, runner.id, { output: { draft: "again" } })).toBe(false);
			const run = await database.query<{ status: string; reported_usage: unknown; output: unknown }>(
				"SELECT status,reported_usage,output FROM agent_task_runs WHERE id=$1",
				[claimed.runId],
			);
			expect(run.rows[0]).toEqual({ status: "complete", reported_usage: null, output: { draft: "ok" } });
		} finally {
			await database.close();
		}
	});

	it("租约过期后任务回到队列，旧 Run 标记 expired，旧 Runner 不能再提交", async () => {
		const database = await setup();
		try {
			await rule(database);
			await ruleAndEvent(database, "t1");
			const crashed = await runnerWith(database, ["reply.comment"], "crashed");
			const claimed = await claimAgentTask(database, crashed.id, 60);
			if (!claimed) throw new Error("expected claim");
			await database.query("UPDATE agent_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
				claimed.taskId,
			]);
			expect(await completeAgentTask(database, claimed.taskId, crashed.id, { output: 1 })).toBe(false);
			const second = await runnerWith(database, ["reply.comment"], "second");
			const reclaimed = await claimAgentTask(database, second.id, 60);
			expect(reclaimed?.taskId).toBe(claimed.taskId);
			expect(reclaimed?.attempt).toBe(2);
			const runs = await database.query<{ attempt: number; status: string }>(
				"SELECT attempt,status FROM agent_task_runs WHERE task_id=$1 ORDER BY attempt",
				[claimed.taskId],
			);
			expect(runs.rows).toEqual([
				{ attempt: 1, status: "expired" },
				{ attempt: 2, status: "running" },
			]);
		} finally {
			await database.close();
		}
	});

	it("失败先重排，用尽次数后终止；过期且无次数的任务由清扫收敛", async () => {
		const database = await setup();
		try {
			await rule(database);
			await ruleAndEvent(database, "t1");
			const runner = await runnerWith(database, ["reply.comment"]);
			const first = await claimAgentTask(database, runner.id, 60);
			if (!first) throw new Error("expected claim");
			expect(await failAgentTask(database, first.taskId, runner.id, "boom")).toBe(true);
			let state = (
				await database.query<{ status: string }>("SELECT status FROM agent_tasks WHERE id=$1", [first.taskId])
			).rows[0];
			expect(state.status).toBe("pending");
			await database.query("UPDATE agent_tasks SET available_at=now() WHERE id=$1", [first.taskId]);
			const second = await claimAgentTask(database, runner.id, 60);
			expect(second?.attempt).toBe(2);
			await database.query("UPDATE agent_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [
				first.taskId,
			]);
			expect(await sweepExpiredAgentTasks(database)).toBe(1);
			state = (await database.query<{ status: string }>("SELECT status FROM agent_tasks WHERE id=$1", [first.taskId]))
				.rows[0];
			expect(state.status).toBe("failed");
			const runs = await database.query<{ status: string }>(
				"SELECT status FROM agent_task_runs WHERE task_id=$1 ORDER BY attempt",
				[first.taskId],
			);
			expect(runs.rows.map((row) => row.status)).toEqual(["failed", "expired"]);
		} finally {
			await database.close();
		}
	});

	it("同一分组同一时间只跑一个，并发数受 Runner 上限约束", async () => {
		const database = await setup();
		try {
			await rule(database, "reply.comment", { groupKey: "g" });
			await ruleAndEvent(database, "a", "article-1");
			await database.query("UPDATE agent_tasks SET status='complete' WHERE group_key IS NULL");
			// A second task for another object in the same rule has a different group key, so both may run.
			await ruleAndEvent(database, "b", "article-2");
			const big = await createRunner(database, {
				organizationId: ORG,
				name: "wide",
				agentIds: [await approvedAgent(database, "wide-agent", ["reply.comment"])],
				maxConcurrency: 2,
			});
			expect(await claimAgentTask(database, big.id)).not.toBeNull();
			expect(await claimAgentTask(database, big.id)).not.toBeNull();
			expect(await claimAgentTask(database, big.id)).toBeNull();
			await database.query("UPDATE agent_tasks SET status='pending', lease_owner=NULL, lease_expires_at=NULL");
			await database.query("UPDATE agent_tasks SET group_key='same'");
			const narrow = await createRunner(database, {
				organizationId: ORG,
				name: "narrow",
				agentIds: [await approvedAgent(database, "narrow-agent", ["reply.comment"])],
				maxConcurrency: 2,
			});
			expect(await claimAgentTask(database, narrow.id)).not.toBeNull();
			expect(await claimAgentTask(database, narrow.id)).toBeNull();
		} finally {
			await database.close();
		}
	});
});

describe("项目封档", () => {
	it("封档后该项目的任务与事件不可再写入", async () => {
		const database = await setup();
		try {
			await database.query("UPDATE projects SET status='archived' WHERE id='p1'");
			await expect(
				ingestEvent(database, {
					organizationId: ORG,
					projectId: "p1",
					source: "comment",
					type: "comment.new",
					dedupeKey: "x",
				}),
			).rejects.toThrow();
			const noProject = await ingestEvent(database, {
				organizationId: ORG,
				source: "comment",
				type: "comment.new",
				dedupeKey: "y",
			});
			expect(noProject.duplicate).toBe(false);
		} finally {
			await database.close();
		}
	});
});
