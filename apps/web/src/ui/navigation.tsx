import { createContext, useContext } from "react";
import type { View } from "../types";

export type EvidenceFocus = { captureId: string; batchId: string | null } | null;

export type WorkspaceNavigation = {
	openView(view: View): void;
	/** 跳到证据中心并定位到某条回答证据。 */
	openEvidence(captureId: string, batchId?: string | null): void;
	/** 跳到 AI 监测并选中某个批次（例如工作台刚创建的批次）。 */
	openBatch(batchId: string): void;
	/** 跳到 AI 工作台并预填指令。 */
	openWorkbench(message?: string): void;
};

export const NavigationContext = createContext<WorkspaceNavigation>({
	openView: () => undefined,
	openEvidence: () => undefined,
	openBatch: () => undefined,
	openWorkbench: () => undefined,
});

export const useWorkspaceNavigation = (): WorkspaceNavigation => useContext(NavigationContext);
