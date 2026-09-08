import { createHash } from "node:crypto";
import type { Principal } from "@geo/authorization";
import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { describe, expect, it } from "vitest";
import { apiErrorResponse } from "./api-errors";
import { authorizeAction, authorizeArtifact, authorizeRequest, loadActorPrincipal } from "./authorization";
import { changeProjectLifecycle } from "./project-lifecycle";
import { getSharedReport } from "./report-snapshots";
import { createProject, getProject, listProjects } from "./service";
import { resumeWaitingSessions } from "./workbench";

const actor = { kind: "local" } as const;
const input = { name: "生命周期测试客户", region: "测试地区", language: "zh-CN" };
const page = { page: 1, pageSize: 20, offset: 0, search: null };
const scope = { allProjects: true, projectIds: [] };

describe("project lifecycle", () => {
	it("archives atomically, keeps evidence readable and rejects writes through HTTP, execution and database paths", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await migrateDatabase(db);
			const { id } = await createProject(db, input);
			await db.query(
				"INSERT INTO website_snapshots(id,project_id,url,domain,content_text,content_hash,artifact_key,fetched_at) VALUES('site',$1,'https://example.com','example.com','保留原文','hash','test/evidence.html',now())",
				[id],
			);
			await db.query("INSERT INTO monitoring_schedules(id,project_id,enabled) VALUES('schedule',$1,true)", [id]);
			await db.query("INSERT INTO agent_sessions(id,project_id,title,status) VALUES('session',$1,'历史会话','idle')", [
				id,
			]);
			await db.query(
				"INSERT INTO agent_runs(id,project_id,purpose,status,model,prompt_version) VALUES('draft',$1,'optimization_article','awaiting_approval','test','test')",
				[id],
			);
			await changeProjectLifecycle(db, id, "archive", { confirmName: input.name, confirmed: true }, actor);
			expect(await getProject(db, id)).toMatchObject({ status: "archived" });
			expect((await db.query("SELECT enabled FROM monitoring_schedules WHERE id='schedule'")).rows[0].enabled).toBe(
				false,
			);
			const principal = (await loadActorPrincipal(db, actor, "default"))!;
			await expect(authorizeRequest(db, principal, "GET", `/api/projects/${id}`)).resolves.toMatchObject({
				allowed: true,
			});
			await expect(authorizeArtifact(db, principal, "test/evidence.html")).resolves.toBeUndefined();
			await expect(authorizeRequest(db, principal, "PUT", `/api/projects/${id}`)).rejects.toMatchObject({
				status: 409,
			});
			await expect(
				authorizeRequest(db, principal, "POST", "/api/workbench/sessions/session/messages"),
			).rejects.toThrow();
			await expect(
				authorizeAction(db, actor, "workbench.execute", { organizationId: "default", projectId: id }),
			).rejects.toMatchObject({ status: 409 });
			for (const sql of [
				"UPDATE projects SET name='changed' WHERE id=$1",
				"UPDATE projects SET status='active' WHERE id=$1",
				"UPDATE website_snapshots SET content_text='changed' WHERE project_id=$1",
				"INSERT INTO jobs(id,type,payload) VALUES('new','capture',jsonb_build_object('projectId',$1::text))",
				"INSERT INTO agent_session_events(id,session_id,seq,type) VALUES('event','session',1,$1)",
			])
				await expect(db.query(sql, [id])).rejects.toMatchObject({ code: "PZ001" });
			await expect(resumeWaitingSessions(db)).resolves.toBe(0);
			expect((await db.query("SELECT content_text FROM website_snapshots WHERE id='site'")).rows[0].content_text).toBe(
				"保留原文",
			);
			expect((await listProjects(db, "default", page, scope, "archived")).total).toBe(1);
			expect((await listProjects(db, "default", page, scope, "open")).total).toBe(0);
		} finally {
			await db.close();
		}
	}, 20000);

	it("requires confirmation, permissions and scope, and refuses to interrupt queued work", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			const { id } = await createProject(db, input);
			const principal = (await loadActorPrincipal(db, actor, "default"))!;
			const limited: Principal = {
				...principal,
				systemAdmin: false,
				permissions: ["page.customers", "project.onboard"],
			};
			await expect(authorizeRequest(db, limited, "POST", `/api/projects/${id}/archive`)).rejects.toMatchObject({
				status: 403,
			});
			await expect(
				authorizeRequest(
					db,
					{ ...limited, permissions: ["project.delete"], projects: { all: false, ids: [] } },
					"DELETE",
					`/api/projects/${id}`,
				),
			).rejects.toMatchObject({ status: 404 });
			await expect(changeProjectLifecycle(db, id, "delete", { confirmName: input.name }, actor)).rejects.toThrow();
			await expect(
				changeProjectLifecycle(db, id, "delete", { confirmName: "错误名称", confirmed: true }, actor),
			).rejects.toMatchObject({ status: 400 });
			await db.query(
				"INSERT INTO jobs(id,type,payload) VALUES('pending','capture',jsonb_build_object('projectId',$1::text))",
				[id],
			);
			for (const op of ["archive", "delete"] as const)
				await expect(
					changeProjectLifecycle(db, id, op, { confirmName: input.name, confirmed: true }, actor),
				).rejects.toMatchObject({ status: 409 });
			expect((await getProject(db, id))?.status).toBe("draft");
			expect((await db.query("SELECT status FROM jobs WHERE id='pending'")).rows[0].status).toBe("pending");
		} finally {
			await db.close();
		}
	}, 20000);

	it("deletes archived projects from lists, artifacts and shares while preserving all historical rows", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			const { id } = await createProject(db, input);
			await createProject(db, { ...input, name: "保留客户" });
			await db.query(
				"INSERT INTO experiment_batches(id,project_id,kind,status,config,config_hash) VALUES('batch',$1,'baseline','complete','{}','hash')",
				[id],
			);
			await db.query(
				"INSERT INTO prompts(id,project_id,question,intent,position) VALUES('prompt',$1,'测试问题','test',1)",
				[id],
			);
			await db.query(
				"INSERT INTO jobs(id,type,payload,status) VALUES('job','capture',jsonb_build_object('projectId',$1::text),'complete')",
				[id],
			);
			await db.query(
				"INSERT INTO query_captures(id,job_id,batch_id,project_id,prompt_id,platform,attempt,status,answer_text,page_url,adapter_version,collector_node_id,captured_at,raw_artifact_key) VALUES('capture','job','batch',$1,'prompt','deepseek',1,'complete','原始回答','https://example.com','test','test',now(),'test/raw.json')",
				[id],
			);
			await db.query(
				"INSERT INTO report_snapshots(id,project_id,batch_id,report_type,schema_version,title,payload,payload_hash) VALUES('report',$1,'batch','quick_audit','test','测试报告','{}','hash')",
				[id],
			);
			await db.query(
				"INSERT INTO report_shares(id,report_id,token_hash,expires_at) VALUES('share','report',$1,now()+interval '1 day')",
				[createHash("sha256").update("test-token").digest("hex")],
			);
			const before = (await db.query("SELECT * FROM query_captures WHERE id='capture'")).rows;
			await changeProjectLifecycle(db, id, "archive", { confirmName: input.name, confirmed: true }, actor);
			expect(await getSharedReport(db, "test-token")).not.toBeNull();
			await changeProjectLifecycle(db, id, "delete", { confirmName: input.name, confirmed: true }, actor);
			const principal = (await loadActorPrincipal(db, actor, "default"))!;
			await expect(authorizeRequest(db, principal, "GET", "/api/batches/batch")).rejects.toMatchObject({ status: 404 });
			await expect(authorizeArtifact(db, principal, "test/raw.json")).rejects.toMatchObject({ status: 404 });
			expect(await getSharedReport(db, "test-token")).toBeNull();
			expect(await getProject(db, id)).toBeNull();
			expect(await listProjects(db, "default", { ...page, page: 2, pageSize: 1, offset: 1 }, scope)).toMatchObject({
				page: 1,
				total: 1,
			});
			expect((await db.query("SELECT * FROM query_captures WHERE id='capture'")).rows).toEqual(before);
			expect((await db.query("SELECT id FROM report_snapshots WHERE id='report'")).rows).toHaveLength(1);
			await expect(db.query("DELETE FROM projects WHERE id=$1", [id])).rejects.toMatchObject({ code: "PZ002" });
			expect(apiErrorResponse({ code: "PZ001" }, "test").status).toBe(409);
		} finally {
			await db.close();
		}
	}, 20000);
});
