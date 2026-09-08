import { IconCheck, IconCopy, IconDownload, IconEdit, IconExternalLink, IconPlus, IconSend } from "@tabler/icons-react";
import {
	Alert,
	App,
	DatePicker,
	Descriptions,
	Drawer,
	Form,
	Input,
	Modal,
	Select,
	Switch,
	Table,
	Tabs,
	Tag,
	Timeline,
} from "antd";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { Paginated, Project } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";
import { csvCell, downloadText, FilterBar, Pagination, shortDate } from "../ui/primitives";
import { Page } from "./Page";
import "./ContentOperations.css";

const statusLabels: Record<string, string> = {
	draft: "草稿",
	ready: "待执行",
	in_progress: "执行中",
	submitted: "回执待复核",
	verified: "已完成",
	failed: "失败",
	cancelled: "已取消",
	outcome_unknown: "结果待核实",
};
type Channel = {
	id: string;
	name: string;
	platform: string;
	account_name: string;
	profile_url: string | null;
	target_url: string | null;
	instructions: string;
	enabled: boolean;
	revision: number;
	updated_at: string;
};
type Order = {
	id: string;
	article_id: string;
	article_version: number;
	article_title: string;
	channel_name: string;
	platform: string;
	account_name: string;
	assignee_email: string | null;
	assigned_to: string | null;
	scheduled_at: string | null;
	status: string;
	revision: number;
	stale: boolean;
	result_url: string | null;
	updated_at: string;
};
type OrderDetail = Order & {
	notes: string;
	article_snapshot: { title: string; contentMarkdown: string; version: number };
	channel_snapshot: Channel;
	receipts: Array<{ id: string; result_url: string; note: string; submitted_at: string }>;
	events: Array<{ id: string; to_status: string; note: string; created_at: string }>;
};
type ArticleOption = { id: string; title: string; version: number };
type Assignee = { id: string; display_name: string; email: string };
const actions: Record<string, string[]> = {
	draft: ["ready", "cancelled"],
	ready: ["in_progress", "cancelled"],
	in_progress: ["submitted", "failed", "outcome_unknown"],
	submitted: ["verified", "in_progress", "outcome_unknown"],
	outcome_unknown: ["submitted", "failed", "in_progress"],
	failed: ["ready", "cancelled"],
};
const actionLabels: Record<string, string> = {
	ready: "提交待执行",
	in_progress: "开始执行",
	submitted: "提交发布回执",
	verified: "复核完成",
	failed: "标记失败",
	cancelled: "取消工单",
	outcome_unknown: "标记结果不明",
};
const actionPermission = (status: string) =>
	status === "verified"
		? "publications.review"
		: ["in_progress", "submitted", "failed", "outcome_unknown"].includes(status)
			? "publications.execute"
			: "publications.manage";

export function Publications({ project }: { project: Project }) {
	const { message } = App.useApp(),
		navigation = useWorkspaceNavigation(),
		canManage = usePermission("publications.manage");
	const [tab, setTab] = useState("orders"),
		[search, setSearch] = useState(""),
		[status, setStatus] = useState("");
	const [creating, setCreating] = useState(false),
		[channelEdit, setChannelEdit] = useState<Channel | "new" | null>(null),
		[detail, setDetail] = useState<OrderDetail | null>(null);
	const [transition, setTransition] = useState<string | null>(null),
		[assigning, setAssigning] = useState(false),
		[busy, setBusy] = useState(false),
		[loadingDetail, setLoadingDetail] = useState(false);
	const [articles, setArticles] = useState<ArticleOption[]>([]),
		[channels, setChannels] = useState<Channel[]>([]),
		[assignees, setAssignees] = useState<Assignee[]>([]);
	const [orderForm] = Form.useForm(),
		[channelForm] = Form.useForm(),
		[transitionForm] = Form.useForm(),
		[assignmentForm] = Form.useForm();
	const request = useRef(0),
		articleRequest = useRef(0),
		channelRequest = useRef(0);
	const orders = usePaginated<Order>(
		(page, pageSize) =>
			api<Paginated<Order>>(
				`/api/projects/${project.id}/publications?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, status })}`,
			),
		[project.id, search, status],
	);
	const channelList = usePaginated<Channel>(
		(page, pageSize) =>
			api<Paginated<Channel>>(
				`/api/projects/${project.id}/publication-channels?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search })}`,
			),
		[project.id, search],
	);
	useEffect(() => {
		setStatus(navigation.viewFilter ?? "");
		setTab("orders");
	}, [navigation.viewFilter]);
	useEffect(
		() => () => {
			request.current++;
			articleRequest.current++;
			channelRequest.current++;
		},
		[],
	);
	const open = async (id: string) => {
		const current = ++request.current;
		setLoadingDetail(true);
		try {
			const result = await api<OrderDetail>(`/api/publications/${id}`);
			if (current === request.current) setDetail(result);
		} catch (e) {
			message.error(e instanceof Error ? e.message : "工单加载失败");
		} finally {
			if (current === request.current) setLoadingDetail(false);
		}
	};
	const loadArticles = async (text = "") => {
		const current = ++articleRequest.current;
		try {
			const result = await api<Paginated<ArticleOption>>(
				`/api/projects/${project.id}/articles?${new URLSearchParams({ pageSize: "100", search: text })}`,
			);
			if (current === articleRequest.current) setArticles(result.items);
		} catch (e) {
			message.error(e instanceof Error ? e.message : "文章加载失败");
		}
	};
	const loadChannels = async (text = "") => {
		const current = ++channelRequest.current;
		try {
			const result = await api<Paginated<Channel>>(
				`/api/projects/${project.id}/publication-channels?${new URLSearchParams({ pageSize: "100", search: text })}`,
			);
			if (current === channelRequest.current) setChannels(result.items.filter((x) => x.enabled));
		} catch (e) {
			message.error(e instanceof Error ? e.message : "渠道加载失败");
		}
	};
	const loadAssignees = async () => {
		try {
			const result = await api<{ items: Assignee[] }>(`/api/projects/${project.id}/publication-assignees`);
			setAssignees(result.items);
		} catch (e) {
			message.error(e instanceof Error ? e.message : "执行人加载失败");
		}
	};
	const startCreate = () => {
		orderForm.resetFields();
		setCreating(true);
		void loadArticles();
		void loadChannels();
		void loadAssignees();
	};
	const create = async () => {
		try {
			const value = await orderForm.validateFields(),
				article = articles.find((x) => x.id === value.articleId);
			if (!article) {
				message.error("请重新选择文章");
				return;
			}
			setBusy(true);
			const result = await post<{ id: string }>(`/api/projects/${project.id}/publications`, {
				...value,
				articleVersion: article.version,
				assignedTo: value.assignedTo ?? null,
				scheduledAt: value.scheduledAt?.toISOString() ?? null,
				notes: value.notes ?? "",
			});
			setCreating(false);
			message.success("发布工单已创建");
			await orders.reload();
			await open(result.id);
		} catch (e) {
			if (e instanceof Error) message.error(e.message);
		} finally {
			setBusy(false);
		}
	};
	const saveChannel = async () => {
		try {
			const value = await channelForm.validateFields();
			setBusy(true);
			const body = { ...value, expectedRevision: channelEdit !== "new" ? channelEdit?.revision : undefined };
			if (channelEdit === "new") await post(`/api/projects/${project.id}/publication-channels`, body);
			else await api(`/api/publication-channels/${channelEdit?.id}`, { method: "PUT", body: JSON.stringify(body) });
			setChannelEdit(null);
			message.success("渠道已保存");
			await channelList.reload();
		} catch (e) {
			if (e instanceof Error) message.error(e.message);
		} finally {
			setBusy(false);
		}
	};
	const exportPage = () =>
		downloadText(
			"发布工单.csv",
			[
				["文章", "版本", "渠道", "平台", "账号", "执行人", "计划时间", "状态", "发布地址"],
				...orders.items.map((o) => [
					o.article_title,
					o.article_version,
					o.channel_name,
					o.platform,
					o.account_name,
					o.assignee_email,
					shortDate(o.scheduled_at),
					statusLabels[o.status],
					o.result_url,
				]),
			]
				.map((r) => r.map(csvCell).join(","))
				.join("\n"),
			"text/csv;charset=utf-8",
		);
	const error = tab === "orders" ? orders.error : channelList.error;
	return (
		<Page
			title="发布工作台"
			eyebrow="发布工作台"
			breadcrumb={project.name}
			className="content-operations"
			extra={
				<div className="content-toolbar">
					{tab === "orders" ? (
						<>
							<Button
								variant="secondary"
								icon={<IconDownload size={16} />}
								disabled={!orders.items.length}
								onClick={exportPage}
							>
								导出当前页
							</Button>
							<Button permission="publications.manage" icon={<IconPlus size={16} />} onClick={startCreate}>
								新建工单
							</Button>
						</>
					) : (
						<Button
							permission="publications.channels.manage"
							icon={<IconPlus size={16} />}
							onClick={() => {
								channelForm.resetFields();
								channelForm.setFieldValue("enabled", true);
								setChannelEdit("new");
							}}
						>
							新建渠道
						</Button>
					)}
				</div>
			}
		>
			<Tabs
				activeKey={tab}
				onChange={(value) => {
					setTab(value);
					setSearch("");
				}}
				items={[
					{ key: "orders", label: "发布工单" },
					{ key: "channels", label: "渠道与账号" },
				]}
			/>
			<FilterBar>
				<Input.Search
					placeholder={tab === "orders" ? "搜索文章或渠道" : "搜索渠道、平台或账号"}
					allowClear
					onSearch={setSearch}
				/>
				{tab === "orders" && (
					<Select
						aria-label="工单状态"
						value={status}
						onChange={setStatus}
						options={[
							{ value: "", label: "全部状态" },
							...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
						]}
					/>
				)}
			</FilterBar>
			{error != null && <Alert type="error" showIcon title={error instanceof Error ? error.message : "加载失败"} />}
			{tab === "orders" ? (
				<>
					<Table<Order>
						rowKey="id"
						dataSource={orders.items}
						loading={orders.loading || loadingDetail}
						pagination={false}
						columns={[
							{
								title: "文章与版本",
								dataIndex: "article_title",
								render: (value, row) => (
									<>
										<Button variant="link" onClick={() => void open(row.id)}>
											{value}
										</Button>
										<div className="content-summary">
											第 {row.article_version} 版{row.stale ? " · 有更新版本" : ""}
										</div>
									</>
								),
							},
							{
								title: "渠道 / 账号",
								dataIndex: "channel_name",
								render: (value, row) => (
									<>
										{value}
										<div className="content-summary">
											{row.platform} · {row.account_name}
										</div>
									</>
								),
							},
							{ title: "执行人", dataIndex: "assignee_email", render: (v) => v ?? "待分配" },
							{ title: "计划时间", dataIndex: "scheduled_at", width: 140, render: shortDate },
							{
								title: "状态",
								dataIndex: "status",
								width: 125,
								render: (v) => (
									<Tag
										color={
											v === "verified"
												? "success"
												: v === "failed"
													? "error"
													: v === "outcome_unknown"
														? "warning"
														: "default"
										}
									>
										{statusLabels[v]}
									</Tag>
								),
							},
							{
								title: "",
								key: "action",
								width: 80,
								render: (_, row) => (
									<Button
										variant="ghost"
										icon={<IconExternalLink size={16} />}
										title="查看工单"
										onClick={() => void open(row.id)}
									/>
								),
							},
						]}
					/>
					<Pagination {...orders} onPage={orders.setPage} onPageSize={orders.setPageSize} />
				</>
			) : (
				<>
					<Table<Channel>
						rowKey="id"
						dataSource={channelList.items}
						loading={channelList.loading}
						pagination={false}
						columns={[
							{ title: "渠道", dataIndex: "name" },
							{ title: "平台", dataIndex: "platform" },
							{ title: "账号", dataIndex: "account_name" },
							{ title: "状态", dataIndex: "enabled", render: (v) => <Tag>{v ? "启用" : "停用"}</Tag> },
							{ title: "更新", dataIndex: "updated_at", render: shortDate },
							{
								title: "",
								key: "action",
								width: 80,
								render: (_, row) => (
									<Button
										variant="ghost"
										icon={<IconEdit size={16} />}
										permission="publications.channels.manage"
										title="编辑渠道"
										onClick={() => {
											setChannelEdit(row);
											channelForm.setFieldsValue({
												name: row.name,
												platform: row.platform,
												accountName: row.account_name,
												profileUrl: row.profile_url,
												targetUrl: row.target_url,
												instructions: row.instructions,
												enabled: row.enabled,
											});
										}}
									/>
								),
							},
						]}
					/>
					<Pagination {...channelList} onPage={channelList.setPage} onPageSize={channelList.setPageSize} />
				</>
			)}
			<Modal
				title="新建发布工单"
				open={creating}
				onCancel={() => setCreating(false)}
				onOk={() => void create()}
				confirmLoading={busy}
				width={720}
			>
				<Form form={orderForm} name="publication-order-create" layout="vertical">
					<Form.Item name="articleId" label="文章版本" rules={[{ required: true }]}>
						<Select
							showSearch={{ filterOption: false, onSearch: (v) => void loadArticles(v) }}
							options={articles.map((a) => ({ value: a.id, label: `${a.title} · 第 ${a.version} 版` }))}
						/>
					</Form.Item>
					<Form.Item name="channelId" label="渠道与账号" rules={[{ required: true }]}>
						<Select
							showSearch={{ filterOption: false, onSearch: (v) => void loadChannels(v) }}
							options={channels.map((c) => ({ value: c.id, label: `${c.name} · ${c.account_name}` }))}
						/>
					</Form.Item>
					<div className="content-form-grid">
						<Form.Item name="assignedTo" label="执行人">
							<Select
								allowClear
								showSearch={{ optionFilterProp: "label" }}
								options={assignees.map((u) => ({ value: u.id, label: u.display_name || u.email }))}
							/>
						</Form.Item>
						<Form.Item name="scheduledAt" label="计划时间">
							<DatePicker showTime />
						</Form.Item>
					</div>
					<Form.Item name="notes" label="交付要求">
						<Input.TextArea rows={3} maxLength={4000} />
					</Form.Item>
				</Form>
			</Modal>
			<Modal
				title={channelEdit === "new" ? "新建人工发布渠道" : "编辑发布渠道"}
				open={channelEdit !== null}
				onCancel={() => setChannelEdit(null)}
				onOk={() => void saveChannel()}
				confirmLoading={busy}
				width={720}
			>
				<Form form={channelForm} name="publication-channel" layout="vertical">
					<div className="content-form-grid">
						<Form.Item name="name" label="渠道名称" rules={[{ required: true }]}>
							<Input maxLength={160} />
						</Form.Item>
						<Form.Item name="platform" label="平台" rules={[{ required: true }]}>
							<Input maxLength={100} />
						</Form.Item>
						<Form.Item name="accountName" label="账号名称" rules={[{ required: true }]}>
							<Input maxLength={160} />
						</Form.Item>
						<Form.Item name="profileUrl" label="账号主页" rules={[{ type: "url" }]}>
							<Input />
						</Form.Item>
					</div>
					<Form.Item name="targetUrl" label="发布入口" rules={[{ type: "url" }]}>
						<Input />
					</Form.Item>
					<Form.Item name="instructions" label="渠道要求">
						<Input.TextArea rows={4} maxLength={4000} />
					</Form.Item>
					<Form.Item name="enabled" label="启用" valuePropName="checked">
						<Switch />
					</Form.Item>
				</Form>
			</Modal>
			<Drawer
				title={detail?.article_snapshot.title ?? "发布工单"}
				open={detail !== null}
				size={920}
				onClose={() => {
					request.current++;
					setDetail(null);
				}}
			>
				{detail && (
					<>
						<div className="content-toolbar">
							<Tag color={detail.status === "verified" ? "success" : "default"}>{statusLabels[detail.status]}</Tag>
							<span>第 {detail.article_version} 版</span>
							<Button
								variant="secondary"
								icon={<IconCopy size={16} />}
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(detail.article_snapshot.contentMarkdown);
										message.success("已复制工单正文");
									} catch {
										message.error("复制失败，请使用导出");
									}
								}}
							>
								复制正文
							</Button>
							<Button
								variant="secondary"
								icon={<IconDownload size={16} />}
								onClick={() =>
									downloadText(
										`${detail.article_snapshot.title}.md`,
										detail.article_snapshot.contentMarkdown,
										"text/markdown;charset=utf-8",
									)
								}
							>
								导出正文
							</Button>
						</div>
						<Descriptions
							column={2}
							items={[
								{ key: "channel", label: "渠道", children: detail.channel_snapshot.name },
								{ key: "account", label: "账号", children: detail.channel_snapshot.account_name },
								{ key: "platform", label: "平台", children: detail.channel_snapshot.platform },
								{ key: "time", label: "计划时间", children: shortDate(detail.scheduled_at) },
								{
									key: "entry",
									label: "发布入口",
									children: detail.channel_snapshot.target_url ? (
										<a href={detail.channel_snapshot.target_url} target="_blank" rel="noreferrer">
											打开发布页面
										</a>
									) : (
										"未设置"
									),
								},
								{ key: "notes", label: "交付要求", children: detail.notes || "未填写" },
							]}
						/>
						<div className="content-toolbar">
							{canManage && ["draft", "ready", "failed"].includes(detail.status) && (
								<Button
									variant="secondary"
									icon={<IconEdit size={16} />}
									onClick={() => {
										assignmentForm.setFieldsValue({
											assignedTo: detail.assigned_to,
											scheduledAt: detail.scheduled_at ? dayjs(detail.scheduled_at) : null,
											notes: detail.notes,
										});
										setAssigning(true);
										void loadAssignees();
									}}
								>
									调整计划
								</Button>
							)}
							{(actions[detail.status] ?? []).map((next) => (
								<Button
									key={next}
									permission={actionPermission(next)}
									variant={next === "submitted" || next === "verified" ? "primary" : "secondary"}
									icon={next === "verified" ? <IconCheck size={16} /> : <IconSend size={16} />}
									onClick={() => {
										transitionForm.resetFields();
										setTransition(next);
									}}
								>
									{actionLabels[next]}
								</Button>
							))}
						</div>
						{detail.receipts.length > 0 && (
							<>
								<h3>发布回执</h3>
								{detail.receipts.map((r) => (
									<div key={r.id}>
										<a href={r.result_url} target="_blank" rel="noreferrer">
											{r.result_url}
										</a>
										<p>{r.note}</p>
										<small>{shortDate(r.submitted_at)}</small>
									</div>
								))}
							</>
						)}
						<h3>执行记录</h3>
						<Timeline
							items={detail.events.map((e) => ({
								key: e.id,
								content: (
									<>
										<strong>{statusLabels[e.to_status]}</strong>
										<p>{e.note}</p>
										<small>{shortDate(e.created_at)}</small>
									</>
								),
							}))}
						/>
						<h3>绑定的文章正文</h3>
						<pre className="content-evidence-text">{detail.article_snapshot.contentMarkdown}</pre>
					</>
				)}
			</Drawer>
			<Modal
				title={transition ? actionLabels[transition] : "更新工单"}
				open={transition !== null}
				onCancel={() => setTransition(null)}
				confirmLoading={busy}
				onOk={async () => {
					if (!detail || !transition) return;
					try {
						const value = await transitionForm.validateFields();
						setBusy(true);
						await post(`/api/publications/${detail.id}/transition`, {
							...value,
							expectedRevision: detail.revision,
							status: transition,
						});
						setTransition(null);
						message.success("工单状态已更新");
						await orders.reload();
						await open(detail.id);
					} catch (e) {
						if (e instanceof Error) message.error(e.message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<Form form={transitionForm} name="publication-transition" layout="vertical">
					{transition === "submitted" && (
						<Form.Item name="resultUrl" label="实际发布地址" rules={[{ required: true }, { type: "url" }]}>
							<Input />
						</Form.Item>
					)}
					<Form.Item
						name="note"
						label={transition === "verified" ? "复核结论" : "执行说明"}
						rules={[{ required: true }]}
					>
						<Input.TextArea rows={4} maxLength={4000} />
					</Form.Item>
				</Form>
			</Modal>
			<Modal
				title="调整发布计划"
				open={assigning}
				onCancel={() => setAssigning(false)}
				confirmLoading={busy}
				onOk={async () => {
					if (!detail) return;
					try {
						const value = await assignmentForm.validateFields();
						setBusy(true);
						await api(`/api/publications/${detail.id}`, {
							method: "PUT",
							body: JSON.stringify({
								...value,
								expectedRevision: detail.revision,
								assignedTo: value.assignedTo ?? null,
								scheduledAt: value.scheduledAt?.toISOString() ?? null,
								notes: value.notes ?? "",
							}),
						});
						setAssigning(false);
						message.success("发布计划已更新");
						await orders.reload();
						await open(detail.id);
					} catch (e) {
						if (e instanceof Error) message.error(e.message);
					} finally {
						setBusy(false);
					}
				}}
			>
				<Form form={assignmentForm} name="publication-assignment" layout="vertical">
					<Form.Item name="assignedTo" label="执行人">
						<Select allowClear options={assignees.map((u) => ({ value: u.id, label: u.display_name || u.email }))} />
					</Form.Item>
					<Form.Item name="scheduledAt" label="计划时间">
						<DatePicker showTime />
					</Form.Item>
					<Form.Item name="notes" label="交付要求">
						<Input.TextArea rows={3} />
					</Form.Item>
				</Form>
			</Modal>
		</Page>
	);
}
