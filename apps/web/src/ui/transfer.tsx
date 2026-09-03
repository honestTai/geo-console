import { IconDownload, IconUpload } from "@tabler/icons-react";
import { App, Upload } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { downloadText } from "./primitives";

/** 导出文件名统一带日期，便于区分多次导出。 */
export function transferFileName(prefix: string): string {
	return `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
}

export function downloadJson(fileName: string, data: unknown): void {
	downloadText(fileName, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
}

/** 读取用户选中的 JSON 文件并校验最外层 kind，不合格时直接抛中文错误。 */
export async function readJsonBundle(file: File, expectedKind: string, label: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await file.text());
	} catch {
		throw new Error("文件不是有效的 JSON");
	}
	if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).kind !== expectedKind)
		throw new Error(`文件不是本系统导出的${label}包`);
	return parsed as Record<string, unknown>;
}

/**
 * 「导出 / 导入」一对按钮：导出直接下载 JSON；导入选文件后交给调用方处理并提示结果。
 * 导入按钮受 permission 门控；导出只读，跟随页面权限。
 */
export function TransferButtons({
	exportLabel = "导出配置",
	importLabel = "导入配置",
	importPermission,
	expectedKind,
	kindLabel,
	onExport,
	onImport,
}: {
	exportLabel?: string;
	importLabel?: string;
	importPermission?: string;
	expectedKind: string;
	/** 文件类型的中文名，用于错误提示，如“平台设置” */
	kindLabel: string;
	onExport(): Promise<void> | void;
	onImport(bundle: Record<string, unknown>): Promise<string | void>;
}) {
	const { message } = App.useApp();
	const [busy, setBusy] = useState<"export" | "import" | null>(null);
	return (
		<>
			<Button
				variant="secondary"
				icon={<IconDownload size={16} />}
				busy={busy === "export"}
				onClick={async () => {
					setBusy("export");
					try {
						await onExport();
					} catch (reason) {
						message.error(reason instanceof Error ? reason.message : "导出失败");
					} finally {
						setBusy(null);
					}
				}}
			>
				{exportLabel}
			</Button>
			<Upload
				accept=".json,application/json"
				showUploadList={false}
				beforeUpload={(file) => {
					setBusy("import");
					// message.success 返回的是“消息关闭后才 resolve”的 thenable，不能直接 return，否则按钮会多转 3 秒
					void readJsonBundle(file, expectedKind, kindLabel)
						.then((bundle) => onImport(bundle))
						.then((summary) => {
							message.success(summary || "导入完成");
						})
						.catch((reason) => {
							message.error(reason instanceof Error ? reason.message : "导入失败");
						})
						.finally(() => setBusy(null));
					return false;
				}}
			>
				<Button permission={importPermission} variant="secondary" icon={<IconUpload size={16} />} busy={busy === "import"}>
					{importLabel}
				</Button>
			</Upload>
		</>
	);
}
