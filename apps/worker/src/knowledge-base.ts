import { randomUUID } from "node:crypto";
import type { Database } from "@geo/core";
import { z } from "zod";

const questionSchema = z.object({
	industry: z.string().trim().min(1).max(120),
	question: z.string().trim().min(4).max(500),
	intent: z.string().trim().min(1).max(120),
	topic: z.preprocess(
		(value) => (value === "" ? null : value),
		z.string().trim().min(1).max(120).nullable().optional(),
	),
	persona: z.preprocess(
		(value) => (value === "" ? null : value),
		z.string().trim().min(1).max(120).nullable().optional(),
	),
	tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
});

export type LibraryQuestionInput = z.infer<typeof questionSchema>;

export async function listLibraryQuestions(
	database: Database,
	organizationId: string,
	industry?: string | null,
): Promise<unknown[]> {
	return (
		await database.query(
			`SELECT q.id,q.organization_id,q.industry,q.question,q.intent,q.topic,q.persona,q.tags,q.created_at,q.updated_at,
			 u.email AS created_by_email
			 FROM prompt_library_questions q LEFT JOIN users u ON u.id=q.created_by
			 WHERE q.organization_id=$1 AND q.archived_at IS NULL
			 AND ($2::text IS NULL OR lower(q.industry)=lower($2))
			 ORDER BY q.industry,q.created_at`,
			[organizationId, industry?.trim() || null],
		)
	).rows;
}

export async function createLibraryQuestion(
	database: Database,
	organizationId: string,
	createdBy: string | null,
	input: unknown,
): Promise<{ id: string }> {
	const data = questionSchema.parse(input);
	const duplicate = (
		await database.query(
			`SELECT id FROM prompt_library_questions WHERE organization_id=$1 AND archived_at IS NULL
			 AND lower(industry)=lower($2) AND lower(question)=lower($3) LIMIT 1`,
			[organizationId, data.industry, data.question],
		)
	).rows[0];
	if (duplicate) throw new Error("该行业的问题库中已存在相同问题");
	const id = randomUUID();
	await database.query(
		`INSERT INTO prompt_library_questions
		 (id,organization_id,industry,question,intent,topic,persona,tags,created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
		[
			id,
			organizationId,
			data.industry,
			data.question,
			data.intent,
			data.topic ?? null,
			data.persona ?? null,
			JSON.stringify([...new Set(data.tags)]),
			createdBy,
		],
	);
	return { id };
}

export async function archiveLibraryQuestion(
	database: Database,
	organizationId: string,
	questionId: string,
): Promise<void> {
	const result = await database.query(
		`UPDATE prompt_library_questions SET archived_at=COALESCE(archived_at,now()),updated_at=now()
		 WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL`,
		[questionId, organizationId],
	);
	if (result.affectedRows !== 1) throw new Error("知识库问题不存在");
}
