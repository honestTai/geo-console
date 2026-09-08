import { IconArchive, IconCheck, IconEdit, IconHistory, IconPlus, IconX } from "@tabler/icons-react";
import { Alert, App, Descriptions, Drawer, Form, Input, Modal, Select, Table, Tag, Timeline } from "antd";
import { useEffect, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { Paginated, Project } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { downloadText, FilterBar, Pagination, shortDate } from "../ui/primitives";
import { Page } from "./Page";
import "./ContentOperations.css";

const kinds: Record<string, string> = {
	product: "产品资料",
	case: "客户案例",
	fact: "事实与参数",
	material: "内容素材",
};
const statuses: Record<string, string> = { draft: "待核实", approved: "已批准", archived: "已归档" };
type Asset = {
	id: string;
	title: string;
	kind: string;
	status: string;
	current_revision: number;
	revision_id: string;
	source_url: string | null;
	source_note: string;
	valid_until: string | null;
	expired: boolean;
	updated_at: string;
};
type Revision = {
	id: string;
	revision: number;
	title: string;
	kind: string;
	content: string;
	source_url: string | null;
	source_note: string;
	valid_until: string | null;
	created_at: string;
};
type Detail = Asset & {
	revisions: Revision[];
	reviews: Array<{ id: string; decision: string; note: string; created_at: string; revision_id: string }>;
};

export function CustomerKnowledge({ project }: { project: Project }) {
	const { message } = App.useApp(),
		navigation = useWorkspaceNavigation();
	const canManage = usePermission("knowledge.assets.manage"),
		canReview = usePermission("knowledge.assets.review");
	const [search, setSearch] = useState(""),
		[status, setStatus] = useState("");
	const [detail, setDetail] = useState<Detail | null>(null),
		[revision, setRevision] = useState<number | null>(null),
		[editing, setEditing] = useState<Detail | "new" | null>(null);
	const [review, setReview] = useState<{ asset: Detail; decision: "approve" | "reject" | "archive" } | null>(null),
		[note, setNote] = useState("");
	const [busy, setBusy] = useState(false),
		[opening, setOpening] = useState(false),
		request = useRef(0);
	const [form] = Form.useForm();
	const list = usePaginated<Asset>(
		(page, pageSize) =>
			api<Paginated<Asset>>(
				`/api/projects/${project.id}/knowledge-assets?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, status })}`,
			),
		[project.id, search, status],
	);
	useEffect(() => {
		setStatus(navigation.viewFilter ?? "");
	}, [navigation.viewFilter]);
	useEffect(
		() => () => {
			request.current++;
		},
		[],
	);
	const open = async (id: string, edit = false) => {
		const current = ++request.current;
		setOpening(true);
		try {
			const value = await api<Detail>(`/api/knowledge-assets/${id}`);
			if (current !== request.current) return;
			if (edit) {
				setEditing(value);
				const latest = value.revisions[0];
				form.setFieldsValue({
					title: latest.title,
					kind: latest.kind,
					content: latest.content,
					sourceUrl: latest.source_url,
					sourceNote: latest.source_note,
					validUntil: latest.valid_until?.slice(0, 10),
				});
			} else {
				setDetail(value);
				setRevision(value.current_revision);
			}
		} catch (e) {
			message.error(e instanceof Error ? e.message : "资料加载失败");
		} finally {
			if (current === request.current) setOpening(false);
		}
	};
	const save = async () => {
		try {
			const value = await form.validateFields();
			setBusy(true);
			const body = {
				...value,
				validUntil: value.validUntil ? new Date(`${value.validUntil}T23:59:59+08:00`).toISOString() : null,
				expectedRevision: editing !== "new" ? editing?.current_revision : undefined,
			};
			if (editing === "new") await post(`/api/projects/${project.id}/knowledge-assets`, body);
			else await api(`/api/knowledge-assets/${editing?.id}`, { method: "PUT", body: JSON.stringify(body) });
			setEditing(null);
			message.success("资料版本已保存，等待核实");
			await list.reload();
		} catch (e) {
			if (e instanceof Error) message.error(e.message);
		} finally {
			setBusy(false);
		}
	};
	const selected = detail?.revisions.find((r) => r.revision === revision) ?? detail?.revisions[0];
	return (
		<Page
			title="客户知识资产"
			eyebrow="客户知识资产"
			className="content-operations"
			breadcrumb={project.name}
			extra={
				<Button
					permission="knowledge.assets.manage"
					icon={<IconPlus size={16} />}
					onClick={() => {
						form.resetFields();
						form.setFieldValue("kind", "product");
						setEditing("new");
					}}
				>
					新建资料
				</Button>
			}
		>
			<FilterBar>
				<Input.Search aria-label="搜索客户知识" placeholder="搜索资料标题或正文" allowClear onSearch={setSearch} />
				<Select
					aria-label="资料状态"
					value={status}
					onChange={setStatus}
					options={[
						{ value: "", label: "全部状态" },
						...Object.entries(statuses).map(([value, label]) => ({ value, label })),
					]}
				/>
			</FilterBar>
			{list.error != null && (
				<Alert type="error" showIcon title={list.error instanceof Error ? list.error.message : "资料加载失败"} />
			)}
			<Table<Asset>
				rowKey="id"
				dataSource={list.items}
				loading={list.loading || opening}
				pagination={false}
				columns={[
					{
						title: "资料",
						dataIndex: "title",
						render: (value, row) => (
							<Button variant="link" onClick={() => void open(row.id)}>
								{value}
							</Button>
						),
					},
					{ title: "类型", dataIndex: "kind", width: 120, render: (v) => kinds[v] ?? v },
					{
						title: "状态",
						dataIndex: "status",
						width: 120,
						render: (v, row) => (
							<Tag color={row.expired ? "warning" : v === "approved" ? "success" : "default"}>
								{row.expired ? "已过期" : statuses[v]}
							</Tag>
						),
					},
					{ title: "版本", dataIndex: "current_revision", width: 90, render: (v) => `第 ${v} 版` },
					{ title: "来源", dataIndex: "source_note", ellipsis: true },
					{ title: "更新", dataIndex: "updated_at", width: 130, render: shortDate },
					{
						title: "",
						key: "action",
						width: 100,
						render: (_, row) => (
							<Button
								variant="ghost"
								icon={<IconEdit size={16} />}
								permission="knowledge.assets.manage"
								disabled={row.status === "archived"}
								title="编辑资料"
								onClick={() => void open(row.id, true)}
							/>
						),
					},
				]}
			/>
			<Pagination {...list} onPage={list.setPage} onPageSize={list.setPageSize} />
			<Modal
				title={editing === "new" ? "新建客户资料" : "保存新的资料版本"}
				open={editing !== null}
				onCancel={() => setEditing(null)}
				onOk={() => void save()}
				confirmLoading={busy}
				width={800}
				destroyOnHidden
			>
				<Form form={form} layout="vertical" name="customer-knowledge-editor">
					<div className="content-form-grid">
						<Form.Item name="title" label="资料标题" rules={[{ required: true }]}>
							<Input maxLength={200} />
						</Form.Item>
						<Form.Item name="kind" label="资料类型" rules={[{ required: true }]}>
							<Select options={Object.entries(kinds).map(([value, label]) => ({ value, label }))} />
						</Form.Item>
						<Form.Item name="sourceUrl" label="来源网址" rules={[{ type: "url" }]}>
							<Input />
						</Form.Item>
						<Form.Item name="validUntil" label="有效期至">
							<Input type="date" />
						</Form.Item>
					</div>
					<Form.Item name="sourceNote" label="来源与核实依据" rules={[{ required: true }]}>
						<Input.TextArea rows={2} maxLength={2000} />
					</Form.Item>
					<Form.Item name="content" label="资料正文" rules={[{ required: true }]}>
						<Input.TextArea rows={12} maxLength={60000} showCount />
					</Form.Item>
				</Form>
			</Modal>
			<Drawer
				title={detail?.title ?? "资料详情"}
				open={detail !== null}
				size={860}
				onClose={() => {
					request.current++;
					setDetail(null);
				}}
				extra={
					selected && (
						<Button
							variant="secondary"
							icon={<IconHistory size={16} />}
							onClick={() =>
								downloadText(
									`${selected.title}-v${selected.revision}.md`,
									`${selected.content}\n\n来源：${selected.source_note}\n${selected.source_url ?? ""}`,
									"text/markdown;charset=utf-8",
								)
							}
						>
							导出版本
						</Button>
					)
				}
			>
				{detail && selected && (
					<>
						<div className="content-toolbar">
							<Select
								aria-label="资料历史版本"
								value={selected.revision}
								onChange={setRevision}
								options={detail.revisions.map((r) => ({
									value: r.revision,
									label: `第 ${r.revision} 版 · ${shortDate(r.created_at)}`,
								}))}
							/>
							<Tag>{statuses[detail.status]}</Tag>
						</div>
						<Descriptions
							column={1}
							items={[
								{ key: "source", label: "来源依据", children: selected.source_note },
								{
									key: "url",
									label: "来源网址",
									children: selected.source_url ? (
										<a href={selected.source_url} target="_blank" rel="noreferrer">
											{selected.source_url}
										</a>
									) : (
										"未填写"
									),
								},
								{
									key: "valid",
									label: "有效期",
									children: selected.valid_until ? shortDate(selected.valid_until) : "未限定",
								},
							]}
						/>
						<pre className="content-evidence-text">{selected.content}</pre>
						{detail.status !== "archived" && selected.revision === detail.current_revision && (
							<div className="content-toolbar">
								{canManage && (
									<Button variant="secondary" icon={<IconEdit size={16} />} onClick={() => void open(detail.id, true)}>
										编辑
									</Button>
								)}
								{canReview &&
									(["approve", "reject", "archive"] as const).map((decision) => (
										<Button
											key={decision}
											variant={decision === "approve" ? "primary" : "secondary"}
											icon={
												decision === "approve" ? (
													<IconCheck size={16} />
												) : decision === "archive" ? (
													<IconArchive size={16} />
												) : (
													<IconX size={16} />
												)
											}
											onClick={() => {
												setNote("");
												setReview({ asset: detail, decision });
											}}
										>
											{decision === "approve" ? "批准资料" : decision === "reject" ? "退回核实" : "归档"}
										</Button>
									))}
							</div>
						)}
						<h3>核实记录</h3>
						<Timeline
							items={detail.reviews.map((r) => ({
								key: r.id,
								content: (
									<>
										<strong>{r.decision === "approve" ? "批准" : r.decision === "archive" ? "归档" : "退回"}</strong>
										<p>{r.note}</p>
										<small>{shortDate(r.created_at)}</small>
									</>
								),
							}))}
						/>
					</>
				)}
			</Drawer>
			<Modal
				title="记录核实结论"
				open={review !== null}
				onCancel={() => setReview(null)}
				confirmLoading={busy}
				onOk={async () => {
					if (!review || !note.trim()) {
						message.warning("请填写核实说明");
						return;
					}
					setBusy(true);
					try {
						await post(`/api/knowledge-assets/${review.asset.id}/review`, {
							expectedRevision: review.asset.current_revision,
							decision: review.decision,
							note,
						});
						setReview(null);
						message.success("核实结论已保存");
						await list.reload();
						await open(review.asset.id);
					} catch (e) {
						message.error(e instanceof Error ? e.message : "操作失败");
					} finally {
						setBusy(false);
					}
				}}
			>
				<Input.TextArea
					aria-label="核实说明"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					rows={4}
					maxLength={2000}
				/>
			</Modal>
		</Page>
	);
}
