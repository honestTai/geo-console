import type { Database } from "@geo/core";
import { z } from "zod";
import { HttpInputError, normalizeDomain } from "./utils";

export const optionalWebsiteSchema = z.preprocess(
	(value) => (typeof value === "string" ? value.trim() || null : value),
	z
		.url()
		.refine((value) => {
			const url = new URL(value);
			return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
		}, "官网只支持不含凭据的 HTTP(S) 地址")
		.nullish(),
);

export const projectProfileSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		websiteUrl: optionalWebsiteSchema,
		region: z.string().trim().min(1).max(200),
		language: z.string().trim().min(1).max(80),
		industry: z.string().trim().max(120).nullish(),
		businessFocus: z.string().trim().max(5000).nullish(),
	})
	.strict();

/** Only changes the live customer profile. Frozen batches, audits and reports keep their original facts. */
export async function updateProjectProfile(database: Database, projectId: string, input: unknown) {
	const data = projectProfileSchema.parse(input);
	const website = data.websiteUrl ? new URL(data.websiteUrl).href : null;
	const result = await database.query(
		`UPDATE projects SET name=$2,website_url=$3,domain=$4,region=$5,language=$6,
	 industry=$7,business_focus=$8,updated_at=now() WHERE id=$1 RETURNING id`,
		[
			projectId,
			data.name,
			website,
			website ? normalizeDomain(website) : null,
			data.region,
			data.language,
			data.industry || null,
			data.businessFocus || null,
		],
	);
	if (!result.rows.length) throw new HttpInputError("客户项目不存在", 404);
	return { updated: true };
}
