import { IconDownload, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from "antd";
import { useState } from "react";
import { Page } from "../components/Page";
import type { View } from "../types";

export type DemoRecord = {
	id: string;
	title: string;
	status: string;
	fields: Record<string, string>;
	history: { id: string; text: string }[];
};
export type DemoStore = Partial<Record<View, DemoRecord[]>>;
type Definition = {
	title: string;
	create: string;
	fields: { key: string; label: string; multiline?: boolean }[];
	actions: { label: string; status: string }[];
};
export const definitions: Partial<Record<View, Definition>> = {
	audit: {
		title: "官网 AI 可读性检查",
		create: "新建审计",
		fields: [
			{ key: "url", label: "官网地址" },
			{ key: "scope", label: "检查范围", multiline: true },
		],
		actions: [
			{ label: "运行审计", status: "模拟审计完成" },
			{ label: "重新审计", status: "模拟复查完成" },
			{ label: "查看审计报告", status: "模拟报告就绪" },
		],
	},
	customers: {
		title: "客户管理",
		create: "新建客户",
		fields: [
			{ key: "website", label: "官网" },
			{ key: "region", label: "目标地区" },
			{ key: "notes", label: "客户资料", multiline: true },
		],
		actions: [
			{ label: "确认建档", status: "已建档" },
			{ label: "封档", status: "已封档" },
			{ label: "恢复", status: "已建档" },
		],
	},
	monitor: {
		title: "五平台联网监测",
		create: "新建监测",
		fields: [
			{ key: "questions", label: "监测问题（每行一题）", multiline: true },
			{ key: "platforms", label: "监测平台" },
			{ key: "repeat", label: "重复次数" },
		],
		actions: [
			{ label: "运行监测", status: "模拟采集完成" },
			{ label: "重新解析", status: "模拟解析完成" },
			{ label: "按此配置复测", status: "模拟复测完成" },
			{ label: "暂停", status: "已暂停" },
		],
	},
	evidence: {
		title: "证据中心",
		create: "添加回答记录",
		fields: [
			{ key: "platform", label: "平台" },
			{ key: "answer", label: "回答原文", multiline: true },
			{ key: "source", label: "来源地址" },
		],
		actions: [
			{ label: "核对记录", status: "已核对" },
			{ label: "辅助解读", status: "模拟解读完成" },
		],
	},
	diagnosis: {
		title: "差距诊断",
		create: "新建诊断",
		fields: [
			{ key: "evidence", label: "证据说明", multiline: true },
			{ key: "suggestion", label: "整改建议", multiline: true },
		],
		actions: [
			{ label: "生成诊断", status: "模拟诊断完成" },
			{ label: "批准", status: "已批准" },
			{ label: "转为整改任务", status: "已转任务" },
		],
	},
	customerKnowledge: {
		title: "客户知识资产",
		create: "新建资料",
		fields: [
			{ key: "type", label: "资料类型" },
			{ key: "body", label: "资料正文", multiline: true },
			{ key: "source", label: "来源说明" },
		],
		actions: [
			{ label: "批准资料", status: "已批准" },
			{ label: "撤回批准", status: "待审核" },
			{ label: "归档", status: "已归档" },
		],
	},
	publications: {
		title: "发布工作台",
		create: "新建发布工单",
		fields: [
			{ key: "article", label: "文章名称" },
			{ key: "channel", label: "发布渠道" },
			{ key: "assignee", label: "执行人" },
			{ key: "url", label: "回执地址" },
		],
		actions: [
			{ label: "准备发布", status: "待执行" },
			{ label: "开始执行", status: "执行中" },
			{ label: "提交回执", status: "待复核" },
			{ label: "复核通过", status: "模拟交付完成" },
			{ label: "标记失败", status: "失败" },
		],
	},
	report: {
		title: "报告与交付",
		create: "新建报告",
		fields: [
			{ key: "scope", label: "报告范围", multiline: true },
			{ key: "summary", label: "报告叙述", multiline: true },
			{ key: "followup", label: "后续计划", multiline: true },
		],
		actions: [
			{ label: "生成叙述", status: "模拟叙述完成" },
			{ label: "质检", status: "模拟质检完成" },
			{ label: "批准", status: "已批准" },
			{ label: "冻结报告", status: "已冻结" },
			{ label: "生成文档", status: "模拟文档就绪" },
		],
	},
	attribution: {
		title: "业务数据对照",
		create: "添加业务观察",
		fields: [
			{ key: "source", label: "数据来源" },
			{ key: "metric", label: "指标名称" },
			{ key: "value", label: "数值" },
			{ key: "date", label: "日期" },
		],
		actions: [
			{ label: "校验记录", status: "模拟校验完成" },
			{ label: "确认导入", status: "已记录" },
		],
	},
	knowledge: {
		title: "问题知识库",
		create: "新建问题",
		fields: [
			{ key: "industry", label: "行业" },
			{ key: "topic", label: "主题" },
			{ key: "question", label: "问题内容", multiline: true },
		],
		actions: [
			{ label: "加入监测范围", status: "已加入范围" },
			{ label: "归档", status: "已归档" },
		],
	},
	settings: {
		title: "模型与联网平台",
		create: "添加平台配置",
		fields: [
			{ key: "platform", label: "供应商" },
			{ key: "model", label: "模型名称" },
			{ key: "endpoint", label: "服务地址" },
		],
		actions: [
			{ label: "测试连接", status: "模拟连接完成" },
			{ label: "测试联网", status: "模拟测试完成" },
			{ label: "启用", status: "已启用" },
			{ label: "停用", status: "已停用" },
		],
	},
	members: {
		title: "机构成员",
		create: "添加成员",
		fields: [
			{ key: "email", label: "邮箱" },
			{ key: "role", label: "角色" },
			{ key: "scope", label: "客户范围" },
		],
		actions: [
			{ label: "启用", status: "已启用" },
			{ label: "停用", status: "已停用" },
			{ label: "重置密码", status: "模拟重置完成" },
		],
	},
	auditLogs: {
		title: "审计日志",
		create: "添加操作备注",
		fields: [
			{ key: "actor", label: "操作人" },
			{ key: "object", label: "操作对象" },
			{ key: "detail", label: "操作内容", multiline: true },
		],
		actions: [{ label: "标记已查看", status: "已查看" }],
	},
	serviceLogs: {
		title: "运行日志",
		create: "添加排障记录",
		fields: [
			{ key: "service", label: "服务" },
			{ key: "level", label: "日志级别" },
			{ key: "detail", label: "日志内容", multiline: true },
		],
		actions: [
			{ label: "重试任务", status: "模拟重试完成" },
			{ label: "标记解决", status: "已解决" },
		],
	},
	rbac: {
		title: "角色与授权",
		create: "新建角色",
		fields: [
			{ key: "pages", label: "可访问页面" },
			{ key: "actions", label: "操作权限" },
			{ key: "scope", label: "客户范围" },
		],
		actions: [
			{ label: "保存授权", status: "已授权" },
			{ label: "撤销授权", status: "已撤销" },
		],
	},
	organizations: {
		title: "多租户管理",
		create: "新建机构",
		fields: [
			{ key: "admin", label: "管理员" },
			{ key: "notes", label: "机构说明", multiline: true },
		],
		actions: [
			{ label: "进入机构", status: "当前机构" },
			{ label: "封禁", status: "已封禁" },
			{ label: "恢复", status: "正常" },
		],
	},
};
export function exportRecords(name: string, rows: DemoRecord[]) {
	const href = URL.createObjectURL(
		new Blob([JSON.stringify({ environment: "demo", records: rows }, null, 2)], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = href;
	link.download = `zzgeo-demo-${name}.json`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(href), 1000);
}
export function DemoRecords({
	view,
	store,
	onChange,
	onAction,
}: {
	view: View;
	store: DemoStore;
	onChange(view: View, rows: DemoRecord[]): void;
	onAction(view: View, row: DemoRecord, status: string): void;
}) {
	const definition = definitions[view];
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState("all");
	const [editing, setEditing] = useState<DemoRecord | "new" | null>(null);
	const [detail, setDetail] = useState<DemoRecord | null>(null);
	const [form] = Form.useForm();
	if (!definition) return null;
	const rows = store[view] || [];
	const open = (row: DemoRecord | "new") => {
		form.resetFields();
		if (row !== "new") form.setFieldsValue({ title: row.title, ...row.fields });
		setEditing(row);
	};
	return (
		<Page
			eyebrow={definition.title}
			title={definition.title}
			extra={
				<Button type="primary" icon={<IconPlus size={16} />} onClick={() => open("new")}>
					{definition.create}
				</Button>
			}
		>
			<div className="preview-filter">
				<Space wrap>
					<Input.Search
						aria-label="搜索记录"
						placeholder="搜索名称"
						allowClear
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<Select
						aria-label="筛选状态"
						value={status}
						onChange={setStatus}
						options={[
							{ value: "all", label: "全部状态" },
							...[...new Set(rows.map((row) => row.status))].map((value) => ({ value, label: value })),
						]}
					/>
				</Space>
				<Button icon={<IconDownload size={16} />} onClick={() => exportRecords(view, rows)}>
					导出
				</Button>
			</div>
			<Table<DemoRecord>
				rowKey="id"
				dataSource={rows.filter((row) => row.title.includes(query) && (status === "all" || row.status === status))}
				pagination={{ pageSize: 5, hideOnSinglePage: true }}
				locale={{
					emptyText: (
						<Empty description="暂无模拟记录">
							<Button onClick={() => open("new")}>{definition.create}</Button>
						</Empty>
					),
				}}
				columns={[
					{
						title: "名称",
						dataIndex: "title",
						render: (title, row) => (
							<Button type="link" onClick={() => setDetail(row)}>
								{title}
							</Button>
						),
					},
					{ title: "状态", dataIndex: "status", render: (value) => <Tag>{value}</Tag> },
					{
						title: "操作",
						key: "actions",
						render: (_, row) => (
							<Space wrap>
								<Tooltip title="编辑">
									<Button type="text" aria-label="编辑记录" icon={<IconEdit size={16} />} onClick={() => open(row)} />
								</Tooltip>
								{definition.actions.map((action) => (
									<Button key={action.label} size="small" onClick={() => onAction(view, row, action.status)}>
										{action.label}
									</Button>
								))}
								<Popconfirm
									title="删除这条模拟记录？"
									onConfirm={() =>
										onChange(
											view,
											rows.filter((item) => item.id !== row.id),
										)
									}
								>
									<Button type="text" aria-label="删除记录" danger icon={<IconTrash size={16} />} />
								</Popconfirm>
							</Space>
						),
					},
				]}
			/>
			<Modal
				open={editing !== null}
				title={editing === "new" ? definition.create : "编辑记录"}
				onCancel={() => setEditing(null)}
				onOk={() => form.submit()}
				okText="保存"
			>
				<Form
					form={form}
					layout="vertical"
					onFinish={(values: Record<string, string>) => {
						const { title, ...fields } = values;
						const row: DemoRecord = {
							id: editing && editing !== "new" ? editing.id : crypto.randomUUID(),
							title: title.trim(),
							fields,
							status: editing && editing !== "new" ? editing.status : "待处理",
							history: [
								...(editing && editing !== "new" ? editing.history : []),
								{ id: crypto.randomUUID(), text: editing === "new" ? "创建记录" : "编辑记录" },
							],
						};
						onChange(
							view,
							rows.some((item) => item.id === row.id)
								? rows.map((item) => (item.id === row.id ? row : item))
								: [...rows, row],
						);
						setEditing(null);
					}}
				>
					<Form.Item name="title" label="名称" rules={[{ required: true, whitespace: true, message: "请输入名称" }]}>
						<Input maxLength={160} />
					</Form.Item>
					{definition.fields.map((field) => (
						<Form.Item name={field.key} label={field.label} key={field.key}>
							{field.multiline ? <Input.TextArea rows={3} maxLength={4000} /> : <Input maxLength={500} />}
						</Form.Item>
					))}
				</Form>
			</Modal>
			<Drawer open={detail !== null} onClose={() => setDetail(null)} title={detail?.title}>
				<Tag>模拟记录</Tag>
				{definition.fields.map((field) => (
					<section key={field.key}>
						<h3>{field.label}</h3>
						<p className="preview-article-body">{detail?.fields[field.key] || "未填写"}</p>
					</section>
				))}
				<h3>操作记录</h3>
				<ol>
					{detail?.history.map((item) => (
						<li key={item.id}>{item.text}</li>
					))}
				</ol>
			</Drawer>
		</Page>
	);
}
