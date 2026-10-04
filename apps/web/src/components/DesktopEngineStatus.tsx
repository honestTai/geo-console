import { Button, Space, Tag, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";
import { api, post } from "../api";

type EngineStatus = {
	execution: "client";
	storage: "sqlite";
	revision: number;
	syncing: boolean;
	syncError: string | null;
	lastSynced: string | null;
	credentialsNeedSetup: boolean;
};

export function DesktopEngineStatus() {
	const [status, setStatus] = useState<EngineStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		try {
			setStatus(await api<EngineStatus>("/api/desktop-local/status"));
			setError(null);
		} catch (error) {
			setError(error instanceof Error ? error.message : "本地引擎不可用");
		}
	}, []);
	useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), 10_000);
		return () => window.clearInterval(timer);
	}, [load]);
	const sync = async () => {
		setBusy(true);
		try {
			setStatus(await post<EngineStatus>("/api/desktop-local/sync"));
			setError(null);
		} catch (error) {
			setError(error instanceof Error ? error.message : "同步失败，本机数据已保留");
		} finally {
			setBusy(false);
		}
	};
	const detail =
		error ??
		status?.syncError ??
		(status?.credentialsNeedSetup
			? "此设备从云端恢复；如尚未配置，请在设置中重新填写 Provider 密钥。设备主密钥不会同步。"
			: "业务在本机执行；云端只处理鉴权与工作区存储。关闭窗口期间不会执行定时任务。");
	return (
		<Space size={6}>
			<Tooltip title={detail}>
				<Tag color={error || status?.syncError ? "warning" : status ? "success" : "default"}>
					{error ? "本地引擎异常" : status ? "本地执行 · SQLite" : "启动本地引擎…"}
				</Tag>
			</Tooltip>
			<Tooltip
				title={
					status?.lastSynced
						? `上次同步 ${new Date(status.lastSynced).toLocaleString()} · 版本 ${status.revision}`
						: detail
				}
			>
				<Button size="small" type="text" loading={busy || status?.syncing} onClick={() => void sync()}>
					{error || status?.syncError ? "重试同步" : "同步"}
				</Button>
			</Tooltip>
		</Space>
	);
}
