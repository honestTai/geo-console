import { Button as AntdButton, type ButtonProps as AntdButtonProps } from "antd";
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

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";

const variantProps: Record<ButtonVariant, Pick<AntdButtonProps, "type" | "danger" | "color" | "variant">> = {
	primary: { type: "primary" },
	secondary: { type: "default" },
	ghost: { type: "text" },
	danger: { type: "text", danger: true },
	link: { type: "link" },
};

/**
 * 统一按钮：antd Button 的薄封装，附带权限门控。
 * `permission` 未授权时不渲染；`busy` 映射到 loading。
 */
export function Button({
	children,
	icon,
	variant = "primary",
	busy,
	permission,
	size,
	block,
	className,
	htmlType,
	...props
}: Omit<AntdButtonProps, "type" | "variant" | "color" | "loading" | "size" | "icon"> & {
	icon?: ReactNode;
	variant?: ButtonVariant;
	busy?: boolean;
	permission?: string;
	size?: AntdButtonProps["size"];
	block?: boolean;
}) {
	const identity = useContext(AccessContext);
	if (permission && !hasPermission(identity, permission)) return null;
	return (
		<AntdButton
			{...variantProps[variant]}
			{...props}
			htmlType={htmlType ?? "button"}
			size={size}
			block={block}
			icon={icon}
			loading={busy}
			className={className}
		>
			{children}
		</AntdButton>
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

export function useBatch(project: Project, initialBatchId: string | null = null) {
	const [selected, setSelected] = useState(initialBatchId ?? project.batches[0]?.id ?? null);
	const [batch, setBatch] = useState<Batch | null>(null);
	useEffect(() => {
		if (selected)
			api<Batch>(`/api/batches/${selected}`)
				.then(setBatch)
				.catch(() => setBatch(null));
	}, [selected]);
	return { selected, setSelected, batch };
}
