import { randomUUID } from "node:crypto";
import type { ExecutionActor } from "@geo/authorization";
import type { Database } from "@geo/core";
import { z } from "zod";
import { articleVersion, assertArticlePublishable } from "./article-quality";
import { loadActorPrincipal, withAuthorizedAction } from "./authorization";
import { knowledgeProject } from "./customer-knowledge";
import { type PaginationInput, paginated } from "./pagination";
import { assertProjectAccess } from "./project-state";
import { HttpInputError, parseJsonColumn } from "./utils";

const webUrl = z.url().refine((value) => {
	const url = new URL(value);
	return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "请输入不含凭据的网页地址");
const optionalUrl = z
	.union([z.literal(""), webUrl])
	.nullable()
	.optional()
	.transform((v) => v || null);
const channelInput = z.object({
	name: z.string().trim().min(1).max(160),
	platform: z.string().trim().min(1).max(100),
	accountName: z.string().trim().min(1).max(160),
	profileUrl: optionalUrl,
	targetUrl: optionalUrl,
	instructions: z.string().trim().max(4000).default(""),
	enabled: z.boolean().default(true),
	expectedRevision: z.int().positive().optional(),
});

export async function listPublicationChannels(database: Database, projectId: string, input: PaginationInput) {
	await assertProjectAccess(database, projectId);
	const params = [projectId, input.search ? `%${input.search}%` : null];
	const where = "project_id=$1 AND ($2::text IS NULL OR name ILIKE $2 OR platform ILIKE $2 OR account_name ILIKE $2)";
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM publication_channels WHERE ${where}`,
				params,
			)
		).rows[0].count,
	);
	const rows = (
		await database.query(
			`SELECT * FROM publication_channels WHERE ${where} ORDER BY enabled DESC,updated_at DESC,id LIMIT $3 OFFSET $4`,
			[...params, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function savePublicationChannel(
	database: Database,
	projectId: string,
	channelId: string | null,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = channelInput.parse(input),
		project = await knowledgeProject(database, projectId);
	return withAuthorizedAction(
		database,
		actor,
		"publications.channels.manage",
		{ organizationId: project.organization_id, projectId },
		async (tx) => {
			const id = channelId ?? randomUUID();
			if (channelId) {
				const updated = await tx.query(
					`UPDATE publication_channels SET name=$3,platform=$4,account_name=$5,profile_url=$6,target_url=$7,instructions=$8,enabled=$9,revision=revision+1,updated_at=now()
			 WHERE id=$1 AND project_id=$2 AND revision=$10`,
					[
						id,
						projectId,
						data.name,
						data.platform,
						data.accountName,
						data.profileUrl,
						data.targetUrl,
						data.instructions,
						data.enabled,
						data.expectedRevision ?? 0,
					],
				);
				if (!updated.affectedRows) throw new HttpInputError("渠道不存在或已被修改，请刷新", 409);
			} else
				await tx.query(
					`INSERT INTO publication_channels(id,organization_id,project_id,name,platform,account_name,profile_url,target_url,instructions,enabled)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
					[
						id,
						project.organization_id,
						projectId,
						data.name,
						data.platform,
						data.accountName,
						data.profileUrl,
						data.targetUrl,
						data.instructions,
						data.enabled,
					],
				);
			return { id };
		},
	);
}

async function validateAssignee(database: Database, organizationId: string, projectId: string, userId: string | null) {
	if (!userId) return;
	const principal = await loadActorPrincipal(database, { kind: "user", userId }, organizationId);
	if (
		!principal?.active ||
		principal.organizationSuspended ||
		principal.organizationId !== organizationId ||
		(!principal.systemAdmin &&
			(!principal.permissions.includes("publications.execute") ||
				(!principal.projects.all && !principal.projects.ids.includes(projectId))))
	)
		throw new HttpInputError("执行人没有该客户的发布执行权限", 409);
}

export async function publicationAssignees(database: Database, projectId: string) {
	const project = await knowledgeProject(database, projectId);
	const rows = (
		await database.query<{ id: string; email: string; display_name: string | null }>(
			"SELECT id,email,display_name FROM users WHERE organization_id=$1 AND disabled_at IS NULL ORDER BY email LIMIT 200",
			[project.organization_id],
		)
	).rows;
	const accepted: typeof rows = [];
	for (const row of rows) {
		try {
			await validateAssignee(database, project.organization_id, projectId, row.id);
			accepted.push(row);
		} catch (error) {
			if (!(error instanceof HttpInputError)) throw error;
		}
	}
	return { items: accepted };
}

export async function listPublicationOrders(
	database: Database,
	projectId: string,
	input: PaginationInput,
	filters: { status?: string | null; channelId?: string | null; articleId?: string | null } = {},
) {
	await assertProjectAccess(database, projectId);
	const params = [
		projectId,
		input.search ? `%${input.search}%` : null,
		filters.status || null,
		filters.channelId || null,
		filters.articleId || null,
	];
	const where =
		"o.project_id=$1 AND ($2::text IS NULL OR o.article_snapshot->>'title' ILIKE $2 OR o.channel_snapshot->>'name' ILIKE $2) AND ($3::text IS NULL OR o.status=$3) AND ($4::text IS NULL OR o.channel_id=$4) AND ($5::text IS NULL OR o.article_id=$5)";
	const total = Number(
		(
			await database.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM publication_orders o WHERE ${where}`,
				params,
			)
		).rows[0].count,
	);
	const rows = (
		await database.query(
			`SELECT o.id,o.project_id,o.article_id,o.article_version,o.channel_id,o.status,o.assigned_to,o.scheduled_at,o.revision,o.created_at,o.updated_at,
	 o.article_snapshot->>'title' AS article_title,o.channel_snapshot->>'name' AS channel_name,o.channel_snapshot->>'platform' AS platform,
	 o.channel_snapshot->>'account_name' AS account_name,u.email AS assignee_email,
	 (a.version<>o.article_version OR a.deleted_at IS NOT NULL) AS stale,
	 r.result_url,r.submitted_at FROM publication_orders o JOIN optimization_articles a ON a.id=o.article_id
	 LEFT JOIN users u ON u.id=o.assigned_to LEFT JOIN LATERAL (SELECT result_url,submitted_at FROM publication_receipts WHERE order_id=o.id ORDER BY submitted_at DESC,id DESC LIMIT 1) r ON true
	 WHERE ${where} ORDER BY o.updated_at DESC,o.id LIMIT $6 OFFSET $7`,
			[...params, input.pageSize, input.offset],
		)
	).rows;
	return paginated(rows, total, input);
}

export async function getPublicationOrder(database: Database, orderId: string) {
	const row = (
		await database.query<{
			id: string;
			project_id: string;
			organization_id: string;
			article_id: string;
			article_version: number;
			article_snapshot: unknown;
			channel_snapshot: unknown;
			assigned_to: string | null;
			status: string;
			revision: number;
		}>("SELECT * FROM publication_orders WHERE id=$1", [orderId])
	).rows[0];
	if (!row) throw new HttpInputError("发布工单不存在", 404);
	await assertProjectAccess(database, row.project_id);
	const [receipts, events] = await Promise.all([
		database.query("SELECT * FROM publication_receipts WHERE order_id=$1 ORDER BY submitted_at DESC,id DESC", [
			orderId,
		]),
		database.query("SELECT * FROM publication_events WHERE order_id=$1 ORDER BY created_at,id", [orderId]),
	]);
	return {
		...row,
		article_snapshot: parseJsonColumn<Record<string, unknown>>(row.article_snapshot as string),
		channel_snapshot: parseJsonColumn<Record<string, unknown>>(row.channel_snapshot as string),
		receipts: receipts.rows,
		events: events.rows,
	};
}

const orderInput = z.object({
	articleId: z.string().min(1),
	articleVersion: z.int().positive(),
	channelId: z.string().min(1),
	assignedTo: z.string().min(1).nullable().optional(),
	scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
	notes: z.string().trim().max(4000).default(""),
});
export async function createPublicationOrder(
	database: Database,
	projectId: string,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = orderInput.parse(input),
		project = await knowledgeProject(database, projectId);
	return withAuthorizedAction(
		database,
		actor,
		"publications.manage",
		{ organizationId: project.organization_id, projectId },
		async (tx) => {
			await tx.query("SELECT id FROM optimization_articles WHERE id=$1 FOR UPDATE", [data.articleId]);
			const snapshot = await articleVersion(tx, data.articleId);
			if (snapshot.projectId !== projectId) throw new HttpInputError("文章不存在", 404);
			if (snapshot.version !== data.articleVersion) throw new HttpInputError("文章已更新，请重新选择版本", 409);
			const channel = (
				await tx.query("SELECT * FROM publication_channels WHERE id=$1 AND project_id=$2 AND enabled=true FOR SHARE", [
					data.channelId,
					projectId,
				])
			).rows[0];
			if (!channel) throw new HttpInputError("渠道不存在或已停用", 409);
			await validateAssignee(tx, project.organization_id, projectId, data.assignedTo ?? null);
			const id = randomUUID();
			const inserted = await tx.query(
				`INSERT INTO publication_orders(id,organization_id,project_id,article_id,article_version,article_snapshot,channel_id,channel_snapshot,assigned_to,scheduled_at,notes,created_by)
		 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
				[
					id,
					project.organization_id,
					projectId,
					data.articleId,
					snapshot.version,
					JSON.stringify(snapshot),
					data.channelId,
					JSON.stringify(channel),
					data.assignedTo ?? null,
					data.scheduledAt ?? null,
					data.notes,
					actor.kind === "user" ? actor.userId : null,
				],
			);
			if (!inserted.affectedRows) throw new HttpInputError("该文章版本在此渠道已有工单", 409);
			await publicationEvent(tx, { id, projectId }, null, "draft", "创建发布工单", actor);
			return { id };
		},
	);
}

async function publicationEvent(
	database: Database,
	order: { id: string; projectId: string },
	from: string | null,
	to: string,
	note: string,
	actor: ExecutionActor,
	receiptId: string | null = null,
) {
	await database.query(
		"INSERT INTO publication_events(id,order_id,project_id,from_status,to_status,note,actor,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
		[randomUUID(), order.id, order.projectId, from, to, note, JSON.stringify(actor), receiptId],
	);
}
const transitions: Record<string, string[]> = {
	draft: ["ready", "cancelled"],
	ready: ["in_progress", "cancelled"],
	in_progress: ["submitted", "failed", "outcome_unknown"],
	submitted: ["verified", "in_progress", "outcome_unknown"],
	outcome_unknown: ["submitted", "failed", "in_progress"],
	failed: ["ready", "cancelled"],
	verified: [],
	cancelled: [],
};
const transitionInput = z.object({
	expectedRevision: z.int().positive(),
	status: z.enum(["ready", "in_progress", "submitted", "verified", "failed", "cancelled", "outcome_unknown"]),
	note: z.string().trim().min(1).max(4000),
	resultUrl: optionalUrl,
});
async function preparePublication(
	database: Database,
	order: Awaited<ReturnType<typeof getPublicationOrder>>,
	assignedTo: string | null,
	actor: ExecutionActor,
) {
	await database.query("SELECT id FROM optimization_articles WHERE id=$1 FOR UPDATE", [order.article_id]);
	await assertArticlePublishable(database, order.article_id, order.article_version);
	const channel = (
		await database.query("SELECT id FROM publication_channels WHERE id=$1 AND enabled=true", [
			order.channel_snapshot.id,
		])
	).rows[0];
	if (!channel) throw new HttpInputError("发布渠道已停用", 409);
	if (!assignedTo && actor.kind !== "local") throw new HttpInputError("请先为工单分配执行人", 409);
	await validateAssignee(database, order.organization_id, order.project_id, assignedTo);
	const duplicate = (
		await database.query(
			"SELECT id FROM publication_orders WHERE article_id=$1 AND article_version=$2 AND channel_id=$3 AND id<>$4 AND status NOT IN ('failed','cancelled')",
			[order.article_id, order.article_version, order.channel_snapshot.id, order.id],
		)
	).rows[0];
	if (duplicate) throw new HttpInputError("该文章版本在此渠道已有另一张有效工单", 409);
}
export async function transitionPublication(
	database: Database,
	orderId: string,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = transitionInput.parse(input),
		order = await getPublicationOrder(database, orderId);
	const action =
		data.status === "verified"
			? "publications.review"
			: ["in_progress", "submitted", "failed", "outcome_unknown"].includes(data.status)
				? "publications.execute"
				: "publications.manage";
	return withAuthorizedAction(
		database,
		actor,
		action,
		{ organizationId: order.organization_id, projectId: order.project_id },
		async (tx, principal) => {
			const current = (
				await tx.query<{ status: string; revision: number; assigned_to: string | null }>(
					"SELECT status,revision,assigned_to FROM publication_orders WHERE id=$1 FOR UPDATE",
					[orderId],
				)
			).rows[0];
			if (current.revision !== data.expectedRevision || !transitions[current.status]?.includes(data.status))
				throw new HttpInputError("工单状态已变化或不允许此操作，请刷新", 409);
			if (
				action === "publications.execute" &&
				!principal.systemAdmin &&
				actor.kind === "user" &&
				current.assigned_to !== actor.userId &&
				!principal.permissions.includes("publications.manage")
			)
				throw new HttpInputError("仅工单执行人或发布管理者可执行", 403);
			if (["ready", "in_progress"].includes(data.status))
				await preparePublication(tx, order, current.assigned_to, actor);
			let receiptId: string | null = null;
			if (data.status === "submitted") {
				if (!data.resultUrl) throw new HttpInputError("提交回执需要填写实际发布地址", 400);
				receiptId = randomUUID();
				await tx.query(
					"INSERT INTO publication_receipts(id,order_id,project_id,result_url,note,actor) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
					[receiptId, orderId, order.project_id, data.resultUrl, data.note, JSON.stringify(actor)],
				);
			}
			if (data.status === "verified") {
				const receipt = (
					await tx.query<{ id: string; result_url: string }>(
						"SELECT id,result_url FROM publication_receipts WHERE order_id=$1 ORDER BY submitted_at DESC,id DESC LIMIT 1",
						[orderId],
					)
				).rows[0];
				if (!receipt) throw new HttpInputError("工单没有发布回执", 409);
				receiptId = receipt.id;
				// Receipt verification confirms this frozen delivery, not GEO improvement or a newer article.
				await tx.query(
					"UPDATE optimization_articles SET status='published',published_url=$2,updated_at=now() WHERE id=$1 AND version=$3 AND deleted_at IS NULL",
					[order.article_id, receipt.result_url, order.article_version],
				);
			}
			await tx.query(
				"UPDATE publication_orders SET status=$2,revision=revision+1,updated_at=now(),completed_at=CASE WHEN $2='verified' THEN now() ELSE completed_at END WHERE id=$1",
				[orderId, data.status],
			);
			await publicationEvent(
				tx,
				{ id: orderId, projectId: order.project_id },
				current.status,
				data.status,
				data.note,
				actor,
				receiptId,
			);
			return { id: orderId, status: data.status };
		},
	);
}

export async function updatePublicationAssignment(
	database: Database,
	orderId: string,
	input: unknown,
	actor: ExecutionActor,
) {
	const data = z
		.object({
			expectedRevision: z.int().positive(),
			assignedTo: z.string().min(1).nullable(),
			scheduledAt: z.iso.datetime({ offset: true }).nullable(),
			notes: z.string().trim().max(4000),
		})
		.parse(input);
	const order = await getPublicationOrder(database, orderId);
	return withAuthorizedAction(
		database,
		actor,
		"publications.manage",
		{ organizationId: order.organization_id, projectId: order.project_id },
		async (tx) => {
			await validateAssignee(tx, order.organization_id, order.project_id, data.assignedTo);
			const updated = await tx.query(
				"UPDATE publication_orders SET assigned_to=$2,scheduled_at=$3,notes=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$5 AND status IN ('draft','ready','failed')",
				[orderId, data.assignedTo, data.scheduledAt, data.notes, data.expectedRevision],
			);
			if (!updated.affectedRows) throw new HttpInputError("只能修改尚未执行的工单，或工单已被其他人修改", 409);
			await publicationEvent(
				tx,
				{ id: orderId, projectId: order.project_id },
				order.status,
				order.status,
				"更新执行人或发布计划",
				actor,
			);
			return { id: orderId };
		},
	);
}
