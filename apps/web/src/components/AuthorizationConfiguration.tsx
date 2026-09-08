import { Button } from "../access";
import { Pagination } from "../ui/primitives";
import "./AuthorizationConfiguration.css";
import { Alert, App, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, post, put } from "../api";
import type { Paginated, PermissionRecord } from "../types";

type Policy = {
	id: string;
	key: string;
	kind: "http" | "artifact" | "execution";
	label: string;
	method: string | null;
	path: string | null;
	anyOf: string[];
	allOf: string[];
	resourceType: string;
	resourceParam: string | null;
	scope: "organization" | "project" | "system";
	ownerOnly: boolean;
	systemOnly: boolean;
	allowSuspended: boolean;
	enabled: boolean;
	builtIn: boolean;
	version: number;
};
const emptyPolicy: Omit<Policy, "id" | "version"> = {
	key: "",
	kind: "http",
	label: "",
	method: "GET",
	path: "/api/",
	anyOf: [],
	allOf: [],
	resourceType: "organization",
	resourceParam: null,
	scope: "organization",
	ownerOnly: false,
	systemOnly: false,
	allowSuspended: false,
	enabled: true,
	builtIn: false,
};
const failure = (error: unknown) => (error instanceof Error ? error.message : "授权配置操作失败");

/** Configuration is system-admin only; this UI never substitutes for server enforcement. */
export function AuthorizationConfiguration({
	permissions,
	onChanged,
}: {
	permissions: PermissionRecord[];
	onChanged: () => Promise<void>;
}) {
	const { message } = App.useApp();
	const [tab, setTab] = useState("policies");
	const [data, setData] = useState<Paginated<Policy> & { resourceTypes: string[] }>({
		items: [],
		page: 1,
		pageSize: 20,
		total: 0,
		totalPages: 1,
		resourceTypes: [],
	});
	const [permissionPage, setPermissionPage] = useState(1);
	const [page, setPage] = useState(1),
		[search, setSearch] = useState(""),
		[loading, setLoading] = useState(false),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Policy | "new" | null>(null),
		[permission, setPermission] = useState<PermissionRecord | "new" | null>(null),
		[explanation, setExplanation] = useState<unknown>(null);
	const [policyForm] = Form.useForm(),
		[permissionForm] = Form.useForm(),
		[explainForm] = Form.useForm();
	const requestVersion = useRef(0);
	const reload = useCallback(async () => {
		const version = ++requestVersion.current;
		setLoading(true);
		setError(null);
		try {
			const result = await api<Paginated<Policy> & { resourceTypes: string[] }>(
				`/api/rbac/configuration/policies?page=${page}&pageSize=20&search=${encodeURIComponent(search)}`,
			);
			if (version === requestVersion.current) setData(result);
		} catch (e) {
			if (version === requestVersion.current) setError(failure(e));
		} finally {
			if (version === requestVersion.current) setLoading(false);
		}
	}, [page, search]);
	useEffect(() => {
		void reload();
	}, [reload]);
	const options = permissions.map((p) => ({
		value: p.key,
		label: `${p.label} · ${p.key}${p.enabled === false ? "（已停用）" : ""}`,
	}));
	function editPolicy(p: Policy | "new") {
		setEditing(p);
		policyForm.setFieldsValue(p === "new" ? emptyPolicy : p);
	}
	function editPermission(p: PermissionRecord | "new") {
		setPermission(p);
		permissionForm.setFieldsValue(
			p === "new"
				? {
						key: "",
						kind: "action",
						label: "",
						groupLabel: "自定义功能",
						parentKey: null,
						navigationKey: null,
						enabled: true,
					}
				: {
						key: p.key,
						kind: p.kind,
						label: p.label,
						groupLabel: p.group_label,
						parentKey: p.parent_key ?? null,
						navigationKey: p.navigation_key ?? null,
						enabled: p.enabled !== false,
					},
		);
	}
	async function savePolicy() {
		try {
			const values = await policyForm.validateFields();
			setBusy(true);
			setError(null);
			const base = editing && editing !== "new" ? editing : emptyPolicy;
			const { id: _id, builtIn: _builtIn, ...body } = { ...base, ...values };
			if (editing && editing !== "new")
				await put(`/api/rbac/configuration/policies/${encodeURIComponent(editing.id)}`, body);
			else await post("/api/rbac/configuration/policies", body);
			setEditing(null);
			message.success("策略已保存，新请求立即使用新规则");
			await reload();
			await onChanged();
		} catch (e) {
			if (e instanceof Error) setError(failure(e));
		} finally {
			setBusy(false);
		}
	}
	async function savePermission() {
		try {
			const values = await permissionForm.validateFields();
			setBusy(true);
			setError(null);
			await put("/api/rbac/configuration/permissions", values);
			setPermission(null);
			message.success("权限已保存；新权限还需分配到机构与角色");
			await onChanged();
		} catch (e) {
			if (e instanceof Error) setError(failure(e));
		} finally {
			setBusy(false);
		}
	}
	const immutable = editing !== "new";
	return (
		<Space orientation="vertical" size="middle" className="authorization-configuration">
			<Alert
				type="info"
				showIcon
				title="权限、策略、资源边界分别管理"
				description="新增权限后，需分别授予机构和角色。停用策略会禁止对应操作，客户访问范围仍单独校验。"
			/>
			{error && <Alert type="error" showIcon title={error} closable onClose={() => setError(null)} />}
			<Tabs
				activeKey={tab}
				onChange={setTab}
				items={[
					{
						key: "policies",
						label: "授权策略",
						children: (
							<Space orientation="vertical" className="authorization-full">
								<Space wrap>
									<Input.Search
										placeholder="搜索策略键或名称"
										onSearch={(v) => {
											setPage(1);
											setSearch(v);
										}}
										allowClear
										className="authorization-search"
									/>
									<Button onClick={() => editPolicy("new")}>新增策略</Button>
									<Button onClick={() => void reload()}>刷新</Button>
								</Space>
								<Table
									rowKey="id"
									loading={loading}
									dataSource={data.items}
									scroll={{ x: 850 }}
									pagination={false}
									columns={[
										{
											title: "策略",
											dataIndex: "label",
											render: (_, p: Policy) => (
												<>
													<Typography.Text>{p.label}</Typography.Text>
													<br />
													<Typography.Text type="secondary" style={{ fontSize: 12 }}>
														{p.key}
													</Typography.Text>
												</>
											),
										},
										{
											title: "入口",
											dataIndex: "kind",
											width: 100,
											render: (kind: Policy["kind"]) =>
												({ http: "HTTP 接口", artifact: "证据文件", execution: "后台动作" })[kind],
										},
										{
											title: "权限条件",
											render: (_, p: Policy) => (
												<>
													{p.anyOf.length > 0 && <div>任一：{p.anyOf.join("、")}</div>}
													{p.allOf.length > 0 && <div>全部：{p.allOf.join("、")}</div>}
													{p.systemOnly && <Tag>系统专用</Tag>}
												</>
											),
										},
										{
											title: "隔离",
											dataIndex: "scope",
											width: 110,
											render: (scope: Policy["scope"]) =>
												({ organization: "机构", project: "客户项目", system: "系统管理" })[scope],
										},
										{
											title: "状态",
											render: (_, p: Policy) => (
												<Tag color={p.enabled ? "green" : "red"}>{p.enabled ? "启用" : "停用"}</Tag>
											),
											width: 80,
										},
										{
											title: "操作",
											render: (_, p: Policy) => (
												<Button size="small" onClick={() => editPolicy(p)}>
													编辑
												</Button>
											),
											width: 80,
										},
									]}
								/>
								<Pagination
									page={page}
									pageSize={20}
									total={data.total}
									totalPages={data.totalPages}
									onPage={setPage}
								/>
							</Space>
						),
					},
					{
						key: "permissions",
						label: "权限目录",
						children: (
							<Space orientation="vertical" className="authorization-full">
								<Button onClick={() => editPermission("new")}>新增权限</Button>
								<Table
									rowKey="key"
									dataSource={permissions.slice((permissionPage - 1) * 20, permissionPage * 20)}
									scroll={{ x: 700 }}
									pagination={false}
									columns={[
										{ title: "标识", dataIndex: "key" },
										{ title: "名称", dataIndex: "label" },
										{ title: "分组", dataIndex: "group_label" },
										{ title: "类型", dataIndex: "kind", render: (kind: string) => (kind === "page" ? "页面" : "功能") },
										{ title: "状态", render: (_, p: PermissionRecord) => (p.enabled === false ? "停用" : "启用") },
										{
											title: "操作",
											render: (_, p: PermissionRecord) => (
												<Button size="small" onClick={() => editPermission(p)}>
													编辑
												</Button>
											),
										},
									]}
								/>
								<Pagination
									page={permissionPage}
									pageSize={20}
									total={permissions.length}
									totalPages={Math.ceil(permissions.length / 20)}
									onPage={setPermissionPage}
								/>
							</Space>
						),
					},
					{
						key: "explain",
						label: "授权诊断",
						children: (
							<>
								<Alert type="info" title="仅检查权限，不执行请求。" />
								<Form
									form={explainForm}
									layout="vertical"
									initialValues={{ method: "GET", path: "/api/projects" }}
									onFinish={async (values) => {
										setBusy(true);
										setError(null);
										try {
											setExplanation(await post("/api/rbac/configuration/explain", values));
										} catch (e) {
											setError(failure(e));
										} finally {
											setBusy(false);
										}
									}}
								>
									<Form.Item name="userId" label="当前机构的用户 ID" rules={[{ required: true }]}>
										<Input />
									</Form.Item>
									<Form.Item name="method" label="方法">
										<Select options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value }))} />
									</Form.Item>
									<Form.Item name="path" label="API 路径（不含查询参数）" rules={[{ required: true }]}>
										<Input />
									</Form.Item>
									<Button htmlType="submit" busy={busy}>
										解释允许或拒绝原因
									</Button>
								</Form>
								{explanation !== null && (
									<pre className="authorization-explanation">{JSON.stringify(explanation, null, 2)}</pre>
								)}
							</>
						),
					},
				]}
			/>
			<Modal
				transitionName=""
				maskTransitionName=""
				title={editing === "new" ? "新增授权策略" : "编辑授权策略"}
				open={editing !== null}
				onCancel={() => setEditing(null)}
				onOk={() => void savePolicy()}
				confirmLoading={busy}
				width={760}
			>
				{error && <Alert type="error" showIcon title={error} />}
				<Form form={policyForm} layout="vertical">
					<Form.Item name="key" label="唯一策略键" rules={[{ required: true }]}>
						<Input disabled={immutable} />
					</Form.Item>
					<Form.Item name="label" label="名称" rules={[{ required: true }]}>
						<Input />
					</Form.Item>
					<Form.Item name="kind" label="入口类型">
						<Select disabled={immutable} options={["http", "artifact", "execution"].map((value) => ({ value }))} />
					</Form.Item>
					<Alert
						type="info"
						title="资源绑定创建后不可修改；非 HTTP 动作的方法、路径与参数留空。新策略不会自动创建 API 或后台功能。"
					/>
					<Form.Item name="method" label="HTTP 方法">
						<Select
							disabled={immutable}
							allowClear
							onClear={() => policyForm.setFieldValue("method", null)}
							options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value }))}
						/>
					</Form.Item>
					<Form.Item name="path" label="路由模板" normalize={(v) => v || null}>
						<Input disabled={immutable} placeholder="/api/projects/:id/example" />
					</Form.Item>
					<Form.Item name="resourceType" label="资源解析器">
						<Select disabled={immutable} options={data.resourceTypes.map((value) => ({ value }))} />
					</Form.Item>
					<Form.Item name="resourceParam" label="路由中的资源参数名" normalize={(v) => v || null}>
						<Input disabled={immutable} />
					</Form.Item>
					<Form.Item name="scope" label="资源隔离">
						<Select disabled={immutable} options={["organization", "project", "system"].map((value) => ({ value }))} />
					</Form.Item>
					<Form.Item name="anyOf" label="满足任一权限（OR）">
						<Select mode="multiple" options={options} optionFilterProp="label" />
					</Form.Item>
					<Form.Item name="allOf" label="同时满足全部权限（AND）">
						<Select mode="multiple" options={options} optionFilterProp="label" />
					</Form.Item>
					<Space wrap>
						{(
							[
								["ownerOnly", "仅创建者"],
								["systemOnly", "仅系统超管"],
								["allowSuspended", "允许封禁机构管理"],
							] as const
						).map(([name, label]) => (
							<Form.Item key={name} name={name} label={label} valuePropName="checked">
								<Switch disabled={immutable} />
							</Form.Item>
						))}
						<Form.Item name="enabled" label="启用" valuePropName="checked">
							<Switch disabled={editing !== null && editing !== "new" && editing.builtIn && editing.systemOnly} />
						</Form.Item>
					</Space>
				</Form>
			</Modal>
			<Modal
				transitionName=""
				maskTransitionName=""
				title={permission === "new" ? "新增权限" : "编辑权限"}
				open={permission !== null}
				onCancel={() => setPermission(null)}
				onOk={() => void savePermission()}
				confirmLoading={busy}
			>
				{error && <Alert type="error" showIcon title={error} />}
				<Form form={permissionForm} layout="vertical">
					<Form.Item name="key" label="权限键（如 content.publish）" rules={[{ required: true }]}>
						<Input disabled={permission !== "new"} />
					</Form.Item>
					<Form.Item name="kind" label="类型">
						<Select
							disabled={permission !== "new"}
							options={[
								{ value: "action", label: "功能" },
								{ value: "page", label: "页面" },
							]}
						/>
					</Form.Item>
					<Form.Item name="label" label="名称" rules={[{ required: true }]}>
						<Input />
					</Form.Item>
					<Form.Item name="groupLabel" label="分组" rules={[{ required: true }]}>
						<Input />
					</Form.Item>
					<Form.Item name="parentKey" label="归属页面">
						<Select
							allowClear
							onClear={() => permissionForm.setFieldValue("parentKey", null)}
							options={options.filter((p) => permissions.find((item) => item.key === p.value)?.kind === "page")}
						/>
					</Form.Item>
					<Form.Item name="navigationKey" hidden>
						<Input />
					</Form.Item>
					<Form.Item name="enabled" label="启用" valuePropName="checked">
						<Switch disabled={permission !== null && permission !== "new" && permission.system_only} />
					</Form.Item>
				</Form>
			</Modal>
		</Space>
	);
}
