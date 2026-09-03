import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PAGE_SIZE, type Paginated } from "../types";

type UsePaginatedOptions = {
	pageSize?: number;
	onError?: (reason: unknown) => void;
};

export function usePaginated<T>(
	fetcher: (page: number, pageSize: number) => Promise<Paginated<T>>,
	deps: unknown[],
	{ pageSize = DEFAULT_PAGE_SIZE, onError }: UsePaginatedOptions = {},
) {
	const [state, setState] = useState<Paginated<T>>({ items: [], page: 1, pageSize, total: 0, totalPages: 1 });
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<unknown>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetcher is recreated by callers each render; adding it would refire the effect every render. Callers pass its varying values through deps instead.
	const load = useCallback(
		async (page = state.page) => {
			setLoading(true);
			try {
				setState(await fetcher(page, state.pageSize));
			} finally {
				setLoading(false);
			}
		},
		[state.page, state.pageSize, ...deps],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: onError is read at call time; adding it would refire the effect whenever callers pass a new inline callback.
	useEffect(() => {
		void load().catch((reason: unknown) => {
			setError(reason);
			if (onError) onError(reason);
			else setState((current) => ({ ...current, items: [] }));
		});
	}, [load]);
	return {
		...state,
		items: state.items,
		setPage: (page: number) => void load(page),
		setPageSize: (nextPageSize: number) => setState((current) => ({ ...current, page: 1, pageSize: nextPageSize })),
		reload: load,
		loading,
		error,
	};
}
