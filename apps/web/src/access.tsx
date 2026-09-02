import { IconLoader2 } from "@tabler/icons-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { api } from "./api";
import type { AgentRun, Batch, Project, UserIdentity } from "./types";

export const AccessContext = createContext<UserIdentity | null>(null);

export function hasPermission(identity: UserIdentity | null, permission: string): boolean {
	return Boolean(identity?.isSuperAdmin || identity?.permissions.includes(permission));
}

export function usePermission(permission: string): boolean {
	return hasPermission(useContext(AccessContext), permission);
}
export function Button({
	children,
	icon,
	variant = "primary",
	busy,
	permission,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	icon?: ReactNode;
	variant?: "primary" | "secondary" | "ghost" | "danger";
	busy?: boolean;
	permission?: string;
}) {
	const identity = useContext(AccessContext);
	if (permission && !hasPermission(identity, permission)) return null;
	const className = ["button", variant, props.className].filter(Boolean).join(" ");
	return (
		<button {...props} type={props.type ?? "button"} className={className} disabled={busy || props.disabled}>
			{busy ? <IconLoader2 className="spin" size={17} /> : icon}
			{children}
		</button>
	);
}
export function useAgentRunPolling(runs: AgentRun[], reload: () => Promise<void>): void {
	const active = runs.some((run) => run.status === "queued" || run.status === "running");
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => void reload().catch(() => undefined), 2_000);
		return () => window.clearInterval(timer);
	}, [active, reload]);
}
export function useBatch(project: Project) {
	const [selected, setSelected] = useState(project.batches[0]?.id ?? null);
	const [batch, setBatch] = useState<Batch | null>(null);
	useEffect(() => {
		if (selected)
			api<Batch>(`/api/batches/${selected}`)
				.then(setBatch)
				.catch(() => setBatch(null));
	}, [selected]);
	return { selected, setSelected, batch };
}
