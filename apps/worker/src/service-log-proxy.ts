import {
	exportServiceLogsCsv,
	logLevels,
	pruneServiceLogs,
	queryServiceLogs,
	type ServiceLogQuery,
	type ServiceLogQueryResult,
} from "@geo/logging";
import { z } from "zod";

const querySchema = z.object({
	service: z
		.string()
		.trim()
		.regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
		.optional(),
	level: z.enum(logLevels).optional(),
	search: z.string().trim().max(200).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	cursor: z.string().max(1_000).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});

function scopedQuery(url: URL, organizationId: string, includeSystem: boolean): ServiceLogQuery {
	const parsed = querySchema.parse(Object.fromEntries(url.searchParams));
	return { ...parsed, organizationId, includeSystem };
}

export async function getServiceLogs(
	url: URL,
	organizationId: string,
	includeSystem: boolean,
): Promise<ServiceLogQueryResult> {
	return queryServiceLogs(scopedQuery(url, organizationId, includeSystem));
}

export async function getServiceLogsCsv(url: URL, organizationId: string, includeSystem: boolean): Promise<string> {
	return exportServiceLogsCsv(scopedQuery(url, organizationId, includeSystem));
}

export async function applyServiceLogRetention(organizationId: string, input: unknown): Promise<{ deleted: number }> {
	const data = z.object({ olderThanDays: z.number().int().min(7).max(3_650) }).parse(input);
	return pruneServiceLogs(organizationId, data.olderThanDays);
}
