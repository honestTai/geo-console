import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PAGE_SIZE, type Paginated } from "../types";

type UsePaginatedOptions = { pageSize?: number; onError?: (reason: unknown) => void };
export function usePaginated<T>(
	fetcher: (page: number, pageSize: number) => Promise<Paginated<T>>,
	deps: unknown[],
	{ pageSize = DEFAULT_PAGE_SIZE, onError }: UsePaginatedOptions = {},
) {
	const [state, setState] = useState<Paginated<T>>({ items: [], page: 1, pageSize, total: 0, totalPages: 1 });
	const [loading, setLoading] = useState(false),
		[error, setError] = useState<unknown>(null);
	const version = useRef(0),
		fetcherRef = useRef(fetcher),
		onErrorRef = useRef(onError),
		currentPage = useRef(1);
	fetcherRef.current = fetcher;
	onErrorRef.current = onError;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Callers explicitly supply query identity through deps; refs keep callbacks current without refiring on each render.
	const load = useCallback(
		async (page = currentPage.current) => {
			const request = ++version.current;
			setLoading(true);
			setError(null);
			try {
				const result = await fetcherRef.current(page, state.pageSize);
				if (request !== version.current) return;
				currentPage.current = result.page;
				setState(result);
			} catch (reason) {
				if (request === version.current) {
					setError(reason);
					setState((current) => ({ ...current, items: [] }));
					onErrorRef.current?.(reason);
				}
				throw reason;
			} finally {
				if (request === version.current) setLoading(false);
			}
		},
		[state.pageSize, ...deps],
	);
	useEffect(() => {
		currentPage.current = 1;
		void load(1).catch(() => undefined);
		return () => {
			version.current += 1;
		};
	}, [load]);
	return {
		...state,
		items: state.items,
		setPage: (page: number) => void load(page).catch(() => undefined),
		setPageSize: (size: number) => setState((current) => ({ ...current, page: 1, pageSize: size })),
		reload: load,
		loading,
		error,
	};
}
