import { z } from "zod";

export type PaginationInput = { page: number; pageSize: number; offset: number; search: string | null };
export type Paginated<T> = {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
};

const paginationSchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(5).max(100).default(20),
	search: z.string().trim().max(200).optional(),
});

export function parsePagination(url: URL): PaginationInput {
	const value = paginationSchema.parse(Object.fromEntries(url.searchParams));
	return {
		page: value.page,
		pageSize: value.pageSize,
		offset: (value.page - 1) * value.pageSize,
		search: value.search || null,
	};
}

export function paginated<T>(items: T[], total: number, input: PaginationInput): Paginated<T> {
	return {
		items,
		page: input.page,
		pageSize: input.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
	};
}
