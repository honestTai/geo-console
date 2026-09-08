import { randomUUID } from "node:crypto";
import type { ExecutionActor } from "@geo/authorization";
import type { Database } from "@geo/core";
import { z } from "zod";
import { loadActorPrincipal, withAuthorizedAction } from "./authorization";
import { parseActor } from "./authorization/execution";
import { type PaginationInput, paginated } from "./pagination";
import { assertProjectAccess } from "./project-state";
import { HttpInputError, sha256, stableJson } from "./utils";

const optionalUrl = z
	.union([z.literal(""), z.url()])
	.nullable()
	.optional()
	.transform((v) => v || null)
	.refine(
		(v) => !v || (["http:", "https:"].includes(new URL(v).protocol) && !new URL(v).username && !new URL(v).password),
		"来源地址必须是无凭据的网页地址",
	);
const assetInput = z.object({
	title: z.string().trim().min(1).max(200),
	kind: z.enum(["product", "case", "fact", "material"]),
	content: z.string().trim().min(1).max(60_000),
	sourceUrl: optionalUrl,
	sourceNote: z.string().trim().min(1).max(2000),
	validUntil: z
		.union([z.literal(""), z.iso.datetime({ offset: true })])
		.nullable()
		.optional()
		.transform((v) => v || null),
	expectedRevision: z.int().positive().optional(),
});

export async function knowledgeProject(database: Database, projectId: string) {
	await assertProjectAccess(database, projectId);
	return (
		await database.query<{ id: string; organization_id: string }>(
			"SELECT id,organization_id FROM projects WHERE id=$1",
			[projectId],
		)
	).rows[0];
}

export async function listCustomerKnowledge(
	database: Database,
	projectId: string,
	input: PaginationInput,
	status: string | null = null,
) {
	await assertProjectAccess(database, projectId);
	const params = [projectId, input.search ? `%${input.search}%` : null, status || null];
	const where =
		"a.project_id=$1 AND ($2::text IS NULL OR a.title ILIKE $2 OR r.content ILIKE $2) AND ($3::text IS NULL OR a.status=$3)";
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM customer_knowledge_assets a JOIN customer_knowledge_revisions r ON r.asset_id=a.id AND r.revision=a.current_revision WHERE ${where}`,
				params,
			)
		).rows[0].count,
	);
	const rows = (
		await database.query(
			`SELECT a.*,r.id AS revision_id,r.source_url,r.source_note,r.valid_until,r.content_hash,length(r.content) AS content_length,
	 (r.valid_until IS NOT NULL AND r.valid_until<now()) AS expired
	 FROM customer_knowledge_assets a JOIN customer_knowledge_revisions r ON r.asset_id=a.id AND r.revision=a.current_revision WHERE ${where}
	 ORDER BY a.updated_at DESC,a.id LIMIT $4 OFFSET $5`,
			[...params, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function getCustomerKnowledge(database: Database, assetId: string) {
	const asset = (
		await database.query<{
			id: string;
			project_id: string;
			organization_id: string;
			current_revision: number;
			status: string;
		}>("SELECT * FROM customer_knowledge_assets WHERE id=$1", [assetId])
	).rows[0];
	if (!asset) throw new HttpInputError("知识资料不存在", 404);
	await assertProjectAccess(database, asset.project_id);
	const revisions = (
		await database.query("SELECT * FROM customer_knowledge_revisions WHERE asset_id=$1 ORDER BY revision DESC", [
			assetId,
		])
	).rows;
	const reviews = (
		await database.query(
			"SELECT v.* FROM customer_knowledge_reviews v JOIN customer_knowledge_revisions r ON r.id=v.revision_id WHERE r.asset_id=$1 ORDER BY v.created_at DESC,v.id DESC",
			[assetId],
		)
	).rows;
	return { ...asset, revisions, reviews };
}

export async function saveCustomerKnowledge(
	database: Database,
	projectId: string,
	assetId: string | null,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = assetInput.parse(input);
	const project = await knowledgeProject(database, projectId);
	return withAuthorizedAction(
		database,
		actor,
		"knowledge.assets.manage",
		{ organizationId: project.organization_id, projectId },
		async (tx) => {
			const current = assetId
				? (
						await tx.query<{ current_revision: number; status: string }>(
							"SELECT current_revision,status FROM customer_knowledge_assets WHERE id=$1 AND project_id=$2 FOR UPDATE",
							[assetId, projectId],
						)
					).rows[0]
				: null;
			if (assetId && !current) throw new HttpInputError("知识资料不存在", 404);
			if (current?.status === "archived") throw new HttpInputError("已归档资料不可修改，请新建资料", 409);
			if (current && current.current_revision !== data.expectedRevision)
				throw new HttpInputError("资料版本已变化，请刷新后修改", 409);
			const id = assetId ?? randomUUID(),
				revision = (current?.current_revision ?? 0) + 1,
				revisionId = randomUUID();
			const userId = actor.kind === "user" ? actor.userId : null;
			if (!current)
				await tx.query(
					"INSERT INTO customer_knowledge_assets(id,organization_id,project_id,title,kind,created_by) VALUES($1,$2,$3,$4,$5,$6)",
					[id, project.organization_id, projectId, data.title, data.kind, userId],
				);
			else
				await tx.query(
					"UPDATE customer_knowledge_assets SET title=$2,kind=$3,current_revision=$4,status='draft',updated_at=now() WHERE id=$1",
					[id, data.title, data.kind, revision],
				);
			const { expectedRevision: _, ...snapshot } = data;
			await tx.query(
				`INSERT INTO customer_knowledge_revisions(id,asset_id,project_id,revision,title,kind,content,source_url,source_note,valid_until,content_hash,created_by)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
				[
					revisionId,
					id,
					projectId,
					revision,
					data.title,
					data.kind,
					data.content,
					data.sourceUrl,
					data.sourceNote,
					data.validUntil,
					sha256(stableJson(snapshot)),
					userId,
				],
			);
			return { id, revision, revisionId };
		},
	);
}

export async function reviewCustomerKnowledge(
	database: Database,
	assetId: string,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = z
		.object({
			expectedRevision: z.int().positive(),
			decision: z.enum(["approve", "reject", "archive"]),
			note: z.string().trim().min(1).max(2000),
		})
		.parse(input);
	const asset = await getCustomerKnowledge(database, assetId);
	return withAuthorizedAction(
		database,
		actor,
		"knowledge.assets.review",
		{ organizationId: asset.organization_id, projectId: asset.project_id },
		async (tx) => {
			const current = (
				await tx.query<{ current_revision: number; status: string }>(
					"SELECT current_revision,status FROM customer_knowledge_assets WHERE id=$1 FOR UPDATE",
					[assetId],
				)
			).rows[0];
			if (current.current_revision !== data.expectedRevision || current.status === "archived")
				throw new HttpInputError("资料版本或状态已变化，请刷新", 409);
			const revision = (
				await tx.query<{ id: string; valid_until: string | null }>(
					"SELECT id,valid_until FROM customer_knowledge_revisions WHERE asset_id=$1 AND revision=$2",
					[assetId, data.expectedRevision],
				)
			).rows[0];
			if (data.decision === "approve" && revision.valid_until && new Date(revision.valid_until).getTime() <= Date.now())
				throw new HttpInputError("资料已过期，请更新来源和有效期", 409);
			await tx.query(
				"INSERT INTO customer_knowledge_reviews(id,revision_id,project_id,decision,note,actor) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
				[randomUUID(), revision.id, asset.project_id, data.decision, data.note, JSON.stringify(actor)],
			);
			await tx.query("UPDATE customer_knowledge_assets SET status=$2,updated_at=now() WHERE id=$1", [
				assetId,
				data.decision === "approve" ? "approved" : data.decision === "archive" ? "archived" : "draft",
			]);
			return { id: assetId, decision: data.decision };
		},
	);
}

export async function approvedKnowledgeSources(database: Database, projectId: string, revisionIds?: string[]) {
	await assertProjectAccess(database, projectId);
	const rows = (
		await database.query<{
			id: string;
			title: string;
			content: string;
			source_url: string | null;
			source_note: string;
			content_hash: string;
		}>(
			`SELECT r.* FROM customer_knowledge_assets a JOIN customer_knowledge_revisions r ON r.asset_id=a.id AND r.revision=a.current_revision
	 WHERE a.project_id=$1 AND a.status='approved' AND (r.valid_until IS NULL OR r.valid_until>now()) AND ($2::text[] IS NULL OR r.id=ANY($2::text[])) ORDER BY a.updated_at DESC LIMIT 30`,
			[projectId, revisionIds ?? null],
		)
	).rows;
	if (revisionIds && new Set(revisionIds).size !== rows.length)
		throw new HttpInputError("引用的知识版本未批准、已失效或不属于当前客户", 409);
	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		text: r.content,
		sourceUrl: r.source_url,
		sourceNote: r.source_note,
		contentHash: r.content_hash,
	}));
}

export async function knowledgeForAgentRun(database: Database, projectId: string, runId: string | null) {
	if (!runId) return [];
	const run = (
		await database.query<{ execution_actor: unknown; organization_id: string }>(
			"SELECT execution_actor,organization_id FROM agent_runs WHERE id=$1 AND project_id=$2",
			[runId, projectId],
		)
	).rows[0];
	if (!run) return [];
	const principal = await loadActorPrincipal(database, parseActor(run.execution_actor), run.organization_id);
	if (
		!principal?.active ||
		principal.organizationSuspended ||
		(!principal.systemAdmin &&
			(!principal.permissions.includes("page.customer_knowledge") ||
				(!principal.projects.all && !principal.projects.ids.includes(projectId))))
	)
		return [];
	const sources = await approvedKnowledgeSources(database, projectId);
	let length = 0;
	return sources.filter((source) => {
		length += source.text.length;
		return length <= 40000;
	});
}
