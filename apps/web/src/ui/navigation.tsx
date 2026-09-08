import { createContext, useContext } from "react";
import type { EvidenceIndexEntry, View } from "../types";

export type EvidenceFocusKind = EvidenceIndexEntry["kind"];
export type EvidenceFocus = { evidenceId: string; batchId: string | null; kind: EvidenceFocusKind } | null;

export type PanelViewItem = { id: View; label: string };

export type WorkspaceNavigation = {
	openView(view: View, filter?: string): void;
	viewFilter?: string | null;
	/** 返回客户项目列表（等同侧栏“← 客户”按钮）。 */
	openProjectList(): void;
	/** 当前客户下可切换的面板（客户工作台视图），页头面包屑用它做面板切换下拉。 */
	panelViews: PanelViewItem[];
	/** 跳到证据中心并定位到某条证据：回答证据按批次定位，联网搜索记录切到“联网搜索”分区。 */
	openEvidence(evidenceId: string, batchId?: string | null, kind?: EvidenceFocusKind): void;
	/** 跳到 AI 监测并选中某个批次（例如工作台刚创建的批次）。 */
	openBatch(batchId: string): void;
	/** 跳到 AI 工作台并预填指令。 */
	openWorkbench(message?: string): void;
};

export const NavigationContext = createContext<WorkspaceNavigation>({
	openView: () => undefined,
	openProjectList: () => undefined,
	panelViews: [],
	openEvidence: () => undefined,
	openBatch: () => undefined,
	openWorkbench: () => undefined,
});

export const useWorkspaceNavigation = (): WorkspaceNavigation => useContext(NavigationContext);
