import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccessContext } from "../access";
import { api } from "../api";
import type { Paginated } from "../types";

export function useMemberOptions<T extends { id: string }>(kind: "roles" | "projects", enabled: boolean) {
	const identity = useContext(AccessContext);
	const authorityKey = JSON.stringify([
		identity?.organizationId,
		identity?.permissions,
		identity?.allProjects,
		identity?.projectIds,
	]);
	const previousAuthority = useRef(authorityKey);
	const [search, setSearch] = useState("");
	const [items, setItems] = useState<T[]>([]);
	const [total, setTotal] = useState(0);
	const [allProjectsAllowed, setAllProjectsAllowed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const page = useRef(0),
		pending = useRef(false),
		generation = useRef(0);
	const load = useCallback(
		async (nextPage: number, signal?: AbortSignal) => {
			if (!enabled) return;
			const current = generation.current;
			pending.current = true;
			setLoading(true);
			try {
				const params = new URLSearchParams({ kind, page: String(nextPage), pageSize: "50", search });
				const result = await api<Paginated<T> & { allProjectsAllowed: boolean }>(`/api/users/options?${params}`, {
					signal,
				});
				if (signal?.aborted || current !== generation.current) return;
				setItems((previous) =>
					nextPage === 1
						? result.items
						: [...new Map([...previous, ...result.items].map((item) => [item.id, item])).values()],
				);
				setTotal(result.total);
				setAllProjectsAllowed(result.allProjectsAllowed);
				page.current = nextPage;
				setError(null);
			} catch (reason) {
				if (!signal?.aborted && current === generation.current)
					setError(reason instanceof Error ? reason.message : "授权选项加载失败");
			} finally {
				if (current === generation.current) {
					pending.current = false;
					setLoading(false);
				}
			}
		},
		[enabled, kind, search],
	);
	useEffect(() => {
		if (previousAuthority.current !== authorityKey) {
			previousAuthority.current = authorityKey;
			setSearch("");
		}
		generation.current += 1;
		page.current = 0;
		pending.current = false;
		setItems([]);
		setTotal(0);
		const controller = new AbortController();
		const timer = setTimeout(() => void load(1, controller.signal), search ? 250 : 0);
		return () => {
			controller.abort();
			clearTimeout(timer);
			generation.current += 1;
		};
	}, [load, search, authorityKey]);
	return {
		items,
		total,
		loading,
		error,
		allProjectsAllowed,
		setSearch,
		reload: () => load(1),
		loadMore: () => {
			if (!pending.current && items.length < total) void load(page.current + 1);
		},
	};
}
