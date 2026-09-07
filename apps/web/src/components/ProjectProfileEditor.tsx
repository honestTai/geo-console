import { Alert, Form, Input, Modal } from "antd";
import { useState } from "react";
import { put } from "../api";
import type { Project } from "../types";

export function ProjectProfileEditor({
	project,
	onClose,
	refresh,
}: {
	project: Project;
	onClose(): void;
	refresh(): Promise<void>;
}) {
	const [form] = Form.useForm();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Modal
			open
			title="编辑客户信息"
			confirmLoading={busy}
			onCancel={onClose}
			onOk={() => form.submit()}
			okText="保存客户信息"
		>
			<p>官网选填，建站后随时补充。变更只影响新基线，历史批次与审计证据保持不变；同条件复测仍使用旧基线的冻结配置。</p>
			{error && <Alert type="error" showIcon title={error} />}
			<Form
				form={form}
				layout="vertical"
				initialValues={{
					name: project.name,
					websiteUrl: project.website_url,
					region: project.region,
					language: project.language,
					industry: project.industry,
					businessFocus: project.business_focus,
				}}
				onFinish={async (values) => {
					setBusy(true);
					setError(null);
					try {
						await put(`/api/projects/${project.id}`, values);
						await refresh();
						onClose();
					} catch (reason) {
						setError(reason instanceof Error ? reason.message : "保存失败");
					} finally {
						setBusy(false);
					}
				}}
			>
				<Form.Item name="name" label="客户名称" rules={[{ required: true }]}>
					<Input />
				</Form.Item>
				<Form.Item
					name="websiteUrl"
					label="官网（选填）"
					rules={[{ type: "url", message: "请输入完整的 HTTP(S) 网址" }]}
				>
					<Input allowClear placeholder="没有官网可留空" />
				</Form.Item>
				<Form.Item name="region" label="目标地区" rules={[{ required: true }]}>
					<Input />
				</Form.Item>
				<Form.Item name="language" label="语言" rules={[{ required: true }]}>
					<Input />
				</Form.Item>
				<Form.Item name="industry" label="所属行业">
					<Input />
				</Form.Item>
				<Form.Item name="businessFocus" label="业务重点">
					<Input.TextArea rows={3} />
				</Form.Item>
			</Form>
		</Modal>
	);
}
