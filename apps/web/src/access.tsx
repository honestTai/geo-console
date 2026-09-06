import { hasRequirements } from "@geo/authorization";
import { Button as AntdButton, type ButtonProps as AntdButtonProps } from "antd";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { api } from "./api";
import type { AgentRun, Batch, Project, UserIdentity } from "./types";

export const AccessContext = createContext<UserIdentity | null>(null);

export function hasPermission(identity: UserIdentity | null, permission: string): boolean {
	return Boolean(
		identity?.isSuperAdmin || (identity && hasRequirements(identity.permissions, { anyOf: [], allOf: [permission] })),
	);
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

const DEFAULT_POLLING_STATUSES: AgentRun["status"][] = ["queued", "running"];

/**
 * 有 run 处于 `activeStatuses` 时每 2 秒刷新。默认只在排队/执行中轮询；
 * 由协调器在后台物化的用途（如优化文章）要把 `awaiting_approval` 也算进去，否则页面会停在“正在生成”。
 */
export function useAgentRunPolling(
	runs: AgentRun[],
	reload: () => Promise<void>,
	activeStatuses: AgentRun["status"][] = DEFAULT_POLLING_STATUSES,
): void {
	const active = runs.some((run) => activeStatuses.includes(run.status));
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
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			if (!selected || controller.signal.aborted) return;
			try {
				const value = await api<Batch>(`/api/batches/${selected}`, { signal: controller.signal });
				if (controller.signal.aborted) return;
				setBatch(value);
				if (
					["queued", "running"].includes(value.status) ||
					["queued", "running"].includes(value.measurement?.status ?? "")
				)
					timer = setTimeout(() => void load(), 3000);
			} catch {
				if (!controller.signal.aborted) {
					setBatch(null);
					timer = setTimeout(() => void load(), 5000);
				}
			}
		};
		void load();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [selected]);
	return { selected, setSelected, batch };
}
