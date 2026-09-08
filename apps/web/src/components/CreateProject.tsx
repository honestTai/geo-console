import { IconChevronRight } from "@tabler/icons-react";
import { App as AntdApp, Button as AntdButton, Form, Input, Modal } from "antd";
import { useState } from "react";
import { post } from "../api";
import "./ProjectHome.css";

type CreateProjectValues = {
	name: string;
	websiteUrl: string;
	region: string;
	language: string;
	industry: string;
	businessFocus?: string;
	aliases?: string;
	knownCompetitors?: string;
};

function splitList(value: string | undefined): string[] {
	return String(value || "")
		.split(/[，,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function CreateProject({
	open,
	onClose,
	onCreated,
	submitLabel = "创建并进入建档",
}: {
	open: boolean;
	onClose(): void;
	onCreated(id: string): void;
	submitLabel?: string;
}) {
	const [form] = Form.useForm<CreateProjectValues>();
	const [busy, setBusy] = useState(false);
	const { message } = AntdApp.useApp();
	async function submit(values: CreateProjectValues) {
		setBusy(true);
		try {
			const result = await post<{ id: string }>("/api/projects", {
				name: values.name,
				websiteUrl: values.websiteUrl,
				region: values.region,
				language: values.language,
				industry: values.industry,
				businessFocus: values.businessFocus || null,
				aliases: splitList(values.aliases),
				knownCompetitors: splitList(values.knownCompetitors),
			});
			onCreated(result.id);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Modal
			className="project-home-modal"
			open={open}
			onCancel={onClose}
			width={720}
			destroyOnHidden
			mask={{ closable: false }}
			title={
				<div>
					<span className="eyebrow">客户建档</span>
					<div className="project-home-modal-title">新建客户</div>
				</div>
			}
			footer={[
				<AntdButton key="cancel" onClick={onClose}>
					取消
				</AntdButton>,
				<AntdButton
					key="submit"
					type="primary"
					loading={busy}
					icon={<IconChevronRight size={17} />}
					onClick={() => form.submit()}
				>
					{submitLabel}
				</AntdButton>,
			]}
		>
			<Form<CreateProjectValues>
				form={form}
				layout="vertical"
				className="create-project-form"
				onFinish={submit}
				initialValues={{ language: "zh-CN" }}
				requiredMark="optional"
			>
				<Form.Item name="name" label="客户名称" rules={[{ required: true, message: "请输入客户名称" }]}>
					<Input placeholder="企业或品牌全称" />
				</Form.Item>
				<Form.Item name="websiteUrl" label="官网" rules={[{ type: "url", message: "请输入有效网址" }]}>
					<Input placeholder="选填；暂时没有官网可留空，后续支持补充" />
				</Form.Item>
				<Form.Item name="region" label="目标地区" rules={[{ required: true, message: "请输入目标地区" }]}>
					<Input placeholder="例如：中国 / 上海" />
				</Form.Item>
				<Form.Item name="language" label="语言" rules={[{ required: true, message: "请输入语言" }]}>
					<Input />
				</Form.Item>
				<Form.Item
					className="form-item-wide"
					name="industry"
					label="所属行业"
					rules={[{ required: true, message: "请输入所属行业" }]}
				>
					<Input placeholder="用于复用机构内同业问题库" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="businessFocus" label="业务重点（可选）">
					<Input.TextArea rows={3} placeholder="本阶段希望重点推广的产品或服务" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="aliases" label="品牌别名（可选）">
					<Input placeholder="用逗号分隔" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="knownCompetitors" label="已知竞品（可选）">
					<Input placeholder="名称或官网，用逗号分隔" />
				</Form.Item>
			</Form>
		</Modal>
	);
}
