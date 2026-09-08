import { Alert, Form, Input, Modal, Typography } from "antd";
import { useState } from "react";
import { api } from "../api";
import type { ProjectSummary } from "../types";

export function ProjectLifecycleDialog({
	project,
	operation,
	onClose,
	onChanged,
}: {
	project: ProjectSummary;
	operation: "archive" | "delete";
	onClose(): void;
	onChanged(): Promise<void>;
}) {
	const [step, setStep] = useState(1);
	const [confirmName, setConfirmName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const deleting = operation === "delete";
	async function submit() {
		if (deleting && step === 1) {
			setStep(2);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api(`/api/projects/${encodeURIComponent(project.id)}${deleting ? "" : "/archive"}`, {
				method: deleting ? "DELETE" : "POST",
				body: JSON.stringify({ confirmName: deleting ? confirmName : project.name, confirmed: true }),
			});
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败，请重试");
			setBusy(false);
			return;
		}
		onClose();
		await onChanged();
	}
	return (
		<Modal
			open
			title={deleting ? (step === 1 ? "删除客户" : "再次确认删除") : "封档客户"}
			onCancel={onClose}
			onOk={() => void submit()}
			confirmLoading={busy}
			closable={!busy}
			mask={{ closable: !busy }}
			keyboard={!busy}
			cancelButtonProps={{ disabled: busy }}
			cancelText="取消"
			okText={deleting ? (step === 1 ? "继续" : "确认删除") : "确认封档"}
			okButtonProps={{ danger: deleting, disabled: deleting && step === 2 && confirmName !== project.name }}
		>
			<Typography.Paragraph>
				<strong>{project.name}</strong>
			</Typography.Paragraph>
			<Alert
				showIcon
				type={deleting ? "warning" : "info"}
				title={deleting ? "删除后无法在系统中恢复" : "封档后仅可查看和下载"}
				description={
					deleting
						? "客户将从列表移除，工作台、历史资料和已有分享链接将无法访问。原始证据按保留规则存储。"
						: "客户资料、监测结果和报告将保留。编辑、采集、AI 任务及周期监测将停止。"
				}
			/>
			{deleting && step === 2 && (
				<Form layout="vertical" className="customer-delete-confirm">
					<Form.Item label="输入客户全名以确认删除">
						<Input
							autoFocus
							aria-label="确认删除的客户名称"
							value={confirmName}
							disabled={busy}
							onChange={(event) => setConfirmName(event.target.value)}
							autoComplete="off"
						/>
					</Form.Item>
				</Form>
			)}
			{error && <Alert className="customer-delete-confirm" type="error" showIcon title={error} />}
		</Modal>
	);
}
