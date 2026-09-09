import {
	IconArticle,
	IconCheck,
	IconClipboardList,
	IconEdit,
	IconExternalLink,
	IconPlus,
	IconRefresh,
	IconShieldCheck,
	IconSparkles,
	IconTrash,
} from "@tabler/icons-react";
import {
	App,
	Button,
	Drawer,
	Empty,
	Form,
	Input,
	Modal,
	Popconfirm,
	Segmented,
	Select,
	Space,
	Statistic,
	Table,
	Tag,
	Tooltip,
} from "antd";
import { useEffect, useState } from "react";
import { Page } from "../components/Page";
import { AppShell, type ShellNavigationItem } from "../components/Shell";
import type { View } from "../types";
import { views } from "../ui/workspace-views";
import { type DemoRecord, DemoRecords, type DemoStore } from "./DemoRecords";

type LocalTask = {
	id: string;
	title: string;
	owner: string;
	priority: string;
	status: "todo" | "in_progress" | "done";
	detail: string;
};
type LocalArticle = { id: string; title: string; body: string; quality?: string };
const navigation: ShellNavigationItem[] = [
	{ id: "remediation", label: "整改中心", icon: IconClipboardList, group: "交互预览" },
	{ id: "workbench", label: "AI 工作台", icon: IconSparkles, group: "交互预览" },
	{ id: "articles", label: "优化文章", icon: IconArticle, group: "交互预览" },
	{ id: "audit", label: "官网审计", icon: IconShieldCheck, group: "交互预览" },
];
navigation.push(
	...views
		.filter((item) => !navigation.some((current) => current.id === item.id))
		.map((item) => ({
			...item,
			group: [
				"customers",
				"knowledge",
				"settings",
				"members",
				"auditLogs",
				"serviceLogs",
				"rbac",
				"organizations",
			].includes(item.id)
				? "机构与系统管理"
				: "客户工作台",
		})),
);
const labels = { todo: "待处理", in_progress: "进行中", done: "已完成" };
const contact = "mailto:honest.tai@outlook.com?subject=ZZ%20Geo%20申请体验账号";

export function ProductPreview() {
	const { message } = App.useApp();
	const [view, setView] = useState<View>("remediation");
	const [tasks, setTasks] = useState<LocalTask[]>([]);
	const [articles, setArticles] = useState<LocalArticle[]>([]);
	const [store, setStore] = useState<DemoStore>({});
	const [executed, setExecuted] = useState(false);
	const [editingTask, setEditingTask] = useState<LocalTask | "new" | null>(null);
	const [editingArticle, setEditingArticle] = useState<LocalArticle | "new" | null>(null);
	const [filter, setFilter] = useState("active");
	const [query, setQuery] = useState("");
	const [readArticle, setReadArticle] = useState(false);
	const [draft, setDraft] = useState("");
	const [requests, setRequests] = useState<{ id: string; text: string }[]>([]);
	const [account, setAccount] = useState(false);
	const [taskForm] = Form.useForm<LocalTask>();
	const [articleForm] = Form.useForm<LocalArticle>();
	const articleBody = Form.useWatch("body", articleForm) || "";
	const articleTitle = Form.useWatch("title", articleForm) || "";
	function selectView(next: View) {
		if (!navigation.some((item) => item.id === next)) return;
		setView(next);
		window.parent.postMessage({ type: "zzgeo:preview-view", view: next }, "*");
	}
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			if (event.source !== window.parent || event.origin !== window.location.origin) return;
			if (event.data?.type === "zzgeo:preview-view" && navigation.some((item) => item.id === event.data.view))
				setView(event.data.view);
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, []);
	function editTask(task: LocalTask | "new") {
		taskForm.resetFields();
		taskForm.setFieldsValue(
			task === "new" ? { title: "", owner: "", priority: "medium", status: "todo", detail: "" } : task,
		);
		setEditingTask(task);
	}
	function editArticle(article: LocalArticle | "new") {
		articleForm.resetFields();
		articleForm.setFieldsValue(article === "new" ? { title: "", body: "" } : article);
		setReadArticle(false);
		setEditingArticle(article);
	}
	function saveTask(values: LocalTask) {
		const task = {
			...values,
			title: values.title.trim(),
			id: editingTask && editingTask !== "new" ? editingTask.id : crypto.randomUUID(),
		};
		setTasks((items) =>
			items.some((item) => item.id === task.id)
				? items.map((item) => (item.id === task.id ? task : item))
				: [...items, task],
		);
		setEditingTask(null);
		message.success("任务已保存在本页");
	}
	function saveArticle(values: LocalArticle) {
		const article = {
			...values,
			title: values.title.trim(),
			id: editingArticle && editingArticle !== "new" ? editingArticle.id : crypto.randomUUID(),
		};
		setArticles((items) =>
			items.some((item) => item.id === article.id)
				? items.map((item) => (item.id === article.id ? article : item))
				: [...items, article],
		);
		setEditingArticle(null);
		message.success("文章已保存在本页");
	}
	const visibleTasks = tasks.filter(
		(task) =>
			(filter === "all" || (filter === "done" ? task.status === "done" : task.status !== "done")) &&
			task.title.includes(query),
	);
	function action(recordView: View, row: DemoRecord, status: string) {
		setStore((current) => ({
			...current,
			[recordView]: (current[recordView] || []).map((item) =>
				item.id === row.id
					? { ...item, status, history: [...item.history, { id: crypto.randomUUID(), text: status }] }
					: item,
			),
		}));
		if (recordView === "diagnosis" && status === "已转任务")
			setTasks((current) => [
				...current,
				{
					id: crypto.randomUUID(),
					title: row.title,
					owner: "",
					priority: "medium",
					status: "todo",
					detail: row.fields.suggestion || "",
				},
			]);
		message.success(status);
	}
	return (
		<AppShell
			project={null}
			view={view}
			navigation={navigation}
			error={null}
			title="交互 Demo"
			subtitle="模拟数据 · 刷新后清空"
			switchLabel="重新开始"
			onSwitchProject={() =>
				Modal.confirm({
					title: "清空本页模拟数据？",
					content: "任务、文章、配置和需求草稿都会清空。",
					okText: "清空",
					cancelText: "取消",
					onOk: () => {
						setTasks([]);
						setArticles([]);
						setStore({});
						setRequests([]);
						setDraft("");
						setExecuted(false);
					},
				})
			}
			onSelectView={selectView}
			account={
				<Space>
					<Tag color="blue">模拟环境</Tag>
					<Button onClick={() => setAccount(true)}>申请账号</Button>
				</Space>
			}
		>
			{!["remediation", "articles", "workbench", "overview"].includes(view) && (
				<DemoRecords
					key={view}
					view={view}
					store={store}
					onChange={(recordView, rows) => setStore((current) => ({ ...current, [recordView]: rows }))}
					onAction={action}
				/>
			)}
			{view === "overview" && (
				<Page eyebrow="项目总览" title="项目总览">
					<div className="preview-stats">
						<Statistic title="客户" value={store.customers?.length || 0} />
						<Statistic title="监测记录" value={store.monitor?.length || 0} />
						<Statistic title="整改任务" value={tasks.length} />
						<Statistic title="文章" value={articles.length} />
					</div>
					<Space wrap>
						<Button onClick={() => selectView("customers")}>管理客户</Button>
						<Button onClick={() => selectView("monitor")}>运行监测</Button>
						<Button onClick={() => selectView("remediation")}>处理整改</Button>
						<Button onClick={() => selectView("report")}>生成报告</Button>
					</Space>
				</Page>
			)}
			{view === "remediation" && (
				<Page
					eyebrow="整改中心"
					title="任务管理"
					extra={
						<Button type="primary" icon={<IconPlus size={16} />} onClick={() => editTask("new")}>
							创建任务
						</Button>
					}
				>
					<div className="preview-filter">
						<Segmented
							options={[
								{ label: "待处理", value: "active" },
								{ label: "已完成", value: "done" },
								{ label: "全部", value: "all" },
							]}
							value={filter}
							onChange={setFilter}
						/>
						<Input.Search
							aria-label="搜索任务"
							placeholder="搜索任务"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							allowClear
						/>
					</div>
					<Table<LocalTask>
						rowKey="id"
						dataSource={visibleTasks}
						pagination={{ pageSize: 5, hideOnSinglePage: true }}
						locale={{
							emptyText: (
								<Empty description="暂无任务">
									<Button icon={<IconPlus size={16} />} onClick={() => editTask("new")}>
										新建任务
									</Button>
								</Empty>
							),
						}}
						columns={[
							{
								title: "任务",
								dataIndex: "title",
								render: (title, task) => (
									<Button type="link" onClick={() => editTask(task)}>
										{title}
									</Button>
								),
							},
							{ title: "负责人", dataIndex: "owner", render: (owner) => owner || "待分配" },
							{
								title: "优先级",
								dataIndex: "priority",
								render: (priority) => <Tag>{priority === "high" ? "高" : priority === "low" ? "低" : "中"}</Tag>,
							},
							{
								title: "状态",
								dataIndex: "status",
								render: (status: LocalTask["status"]) => (
									<Tag color={status === "done" ? "success" : "default"}>{labels[status]}</Tag>
								),
							},
							{
								title: "操作",
								key: "actions",
								render: (_, task) => (
									<Space>
										<Tooltip title="编辑任务">
											<Button
												type="text"
												aria-label="编辑任务"
												icon={<IconEdit size={16} />}
												onClick={() => editTask(task)}
											/>
										</Tooltip>
										<Tooltip title={task.status === "done" ? "重新打开" : "完成任务"}>
											<Button
												type="text"
												aria-label={task.status === "done" ? "重新打开" : "完成任务"}
												icon={task.status === "done" ? <IconRefresh size={16} /> : <IconCheck size={16} />}
												onClick={() =>
													setTasks((items) =>
														items.map((item) =>
															item.id === task.id
																? { ...item, status: item.status === "done" ? "todo" : "done" }
																: item,
														),
													)
												}
											/>
										</Tooltip>
										<Popconfirm
											title="删除这条临时任务？"
											onConfirm={() => setTasks((items) => items.filter((item) => item.id !== task.id))}
										>
											<Button type="text" danger aria-label="删除任务" icon={<IconTrash size={16} />} />
										</Popconfirm>
									</Space>
								),
							},
						]}
					/>
					<div className="preview-stats">
						<Statistic title="总任务数" value={tasks.length} />
						<Statistic title="待处理" value={tasks.filter((task) => task.status === "todo").length} />
						<Statistic title="进行中" value={tasks.filter((task) => task.status === "in_progress").length} />
						<Statistic title="已完成" value={tasks.filter((task) => task.status === "done").length} />
					</div>
				</Page>
			)}
			{view === "articles" && (
				<Page
					eyebrow="优化文章"
					title="文章管理"
					extra={
						<Button type="primary" icon={<IconPlus size={16} />} onClick={() => editArticle("new")}>
							新建草稿
						</Button>
					}
				>
					<Table<LocalArticle>
						rowKey="id"
						dataSource={articles}
						pagination={{ pageSize: 5, hideOnSinglePage: true }}
						locale={{ emptyText: <Empty description="暂无文章" /> }}
						columns={[
							{
								title: "标题",
								dataIndex: "title",
								render: (title, article) => (
									<Button type="link" onClick={() => editArticle(article)}>
										{title}
									</Button>
								),
							},
							{ title: "状态", key: "status", render: (_, article) => <Tag>{article.quality || "模拟草稿"}</Tag> },
							{ title: "字数", key: "length", render: (_, article) => article.body.length },
							{
								title: "操作",
								key: "action",
								render: (_, article) => (
									<Space>
										<Button onClick={() => editArticle(article)}>编辑</Button>
										<Button
											onClick={() =>
												setArticles((items) =>
													items.map((item) => (item.id === article.id ? { ...item, quality: "模拟质检完成" } : item)),
												)
											}
										>
											审核质检
										</Button>
										<Popconfirm
											title="删除临时文章？"
											onConfirm={() => setArticles((items) => items.filter((item) => item.id !== article.id))}
										>
											<Button aria-label="删除文章" icon={<IconTrash size={16} />} danger />
										</Popconfirm>
									</Space>
								),
							},
						]}
					/>
				</Page>
			)}
			{view === "workbench" && (
				<Page
					eyebrow="AI 工作台"
					title="AI 工作台"
					extra={
						<Button
							icon={<IconPlus size={16} />}
							onClick={() => {
								setDraft("");
								setRequests([]);
								setExecuted(false);
							}}
						>
							新会话
						</Button>
					}
				>
					<div className="preview-conversation">
						{requests.length ? (
							requests.map((request) => (
								<p className="preview-request" key={request.id}>
									{request.text}
									<Tag>{executed ? "模拟执行完成" : "待执行"}</Tag>
								</p>
							))
						) : (
							<Empty description="还没有需求草稿" />
						)}
					</div>
					<Form
						onFinish={() => {
							const value = draft.trim();
							if (value) {
								setRequests((items) => [...items, { id: crypto.randomUUID(), text: value }]);
								setExecuted(false);
								setDraft("");
							}
						}}
					>
						<Form.Item>
							<Input.TextArea
								aria-label="需求草稿"
								placeholder="输入这次想完成的工作"
								value={draft}
								maxLength={4000}
								onChange={(event) => setDraft(event.target.value)}
								rows={4}
							/>
						</Form.Item>
						<Space>
							<Button htmlType="submit" disabled={!draft.trim()}>
								保存需求
							</Button>
							<Button
								type="primary"
								icon={<IconSparkles size={16} />}
								disabled={!requests.length && !draft.trim()}
								onClick={() => {
									if (draft.trim()) {
										setRequests((items) => [...items, { id: crypto.randomUUID(), text: draft.trim() }]);
										setDraft("");
									}
									setExecuted(true);
									message.success("模拟执行完成，未调用模型");
								}}
							>
								运行 AI 任务
							</Button>
						</Space>
					</Form>
				</Page>
			)}
			<Modal
				open={editingTask !== null}
				title={editingTask === "new" ? "新建任务" : "编辑任务"}
				onCancel={() => setEditingTask(null)}
				onOk={() => taskForm.submit()}
				okText="保存"
				destroyOnHidden
			>
				<Form form={taskForm} layout="vertical" onFinish={saveTask}>
					<Form.Item
						name="title"
						label="任务标题"
						rules={[{ required: true, whitespace: true, message: "请输入任务标题" }]}
					>
						<Input maxLength={160} />
					</Form.Item>
					<Form.Item name="owner" label="负责人">
						<Input maxLength={80} />
					</Form.Item>
					<Form.Item name="priority" label="优先级">
						<Select
							options={[
								{ value: "high", label: "高" },
								{ value: "medium", label: "中" },
								{ value: "low", label: "低" },
							]}
						/>
					</Form.Item>
					<Form.Item name="status" label="状态">
						<Select options={Object.entries(labels).map(([value, label]) => ({ value, label }))} />
					</Form.Item>
					<Form.Item name="detail" label="任务说明">
						<Input.TextArea rows={3} maxLength={4000} />
					</Form.Item>
				</Form>
			</Modal>
			<Drawer
				open={editingArticle !== null}
				title="编辑文章"
				onClose={() => setEditingArticle(null)}
				size="large"
				extra={
					<Button type="primary" onClick={() => articleForm.submit()}>
						保存
					</Button>
				}
			>
				<Segmented
					options={[
						{ label: "编辑", value: "edit" },
						{ label: "预览", value: "preview" },
					]}
					value={readArticle ? "preview" : "edit"}
					onChange={(value) => setReadArticle(value === "preview")}
				/>
				<Form form={articleForm} layout="vertical" onFinish={saveArticle} className="preview-editor">
					<div hidden={readArticle}>
						<Form.Item
							name="title"
							label="文章标题"
							rules={[{ required: true, whitespace: true, message: "请输入文章标题" }]}
						>
							<Input maxLength={200} />
						</Form.Item>
						<Form.Item name="body" label="正文" rules={[{ required: true, whitespace: true, message: "请输入正文" }]}>
							<Input.TextArea rows={18} maxLength={20000} />
						</Form.Item>
					</div>
					{readArticle && (
						<article>
							<h2>{articleTitle || "未填写标题"}</h2>
							<div className="preview-article-body">{articleBody || "暂无正文"}</div>
						</article>
					)}
				</Form>
			</Drawer>
			<Modal
				open={account}
				title="在线执行需要体验账号"
				onCancel={() => setAccount(false)}
				footer={
					<Button
						type="primary"
						href={contact}
						target="_blank"
						rel="noopener noreferrer"
						icon={<IconExternalLink size={16} />}
					>
						联系申请账号
					</Button>
				}
			>
				<p>真实监测、模型调用、质检与官网抓取需要账号和供应商配置。本页不会执行这些任务，也不会上传填写的内容。</p>
				<p>honest.tai@outlook.com</p>
			</Modal>
		</AppShell>
	);
}
