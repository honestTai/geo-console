import { IconKey } from "@tabler/icons-react";
import {
	Alert,
	Button as AntdButton,
	App,
	Form,
	Input,
	Modal,
	Popconfirm,
	Select,
	Space,
	Switch,
	Table,
	Tag,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { Button, usePermission } from "../access";
import { api, post } from "../api";
import { useMemberOptions } from "../hooks/useMemberOptions";
import { usePaginated } from "../hooks/usePagination";
import type { ManagedUser, Paginated, RoleRecord } from "../types";
import { Pagination, SectionTitle } from "../ui/primitives";
import { Page } from "./Page";
import "./Members.css";

export function Members({ localBypass }: { localBypass: boolean }) {
	return (
		<Page eyebrow="机构成员" title="机构成员" description="维护成员和访问状态；只能授予自己拥有的权限与客户范围。">
			{localBypass ? (
				<Alert
					type="info"
					showIcon
					icon={<IconKey size={18} />}
					title="本机免登录开发模式"
					description="配置管理员邮箱和初始密码后重启，启用机构成员管理。"
				/>
			) : (
				<UserManagement />
			)}
		</Page>
	);
}
type CreateMemberForm = {
	email: string;
	displayName: string;
	roleIds: string[];
	password: string;
	allProjects: boolean;
	projectIds: string[];
};
type ProjectOption = { id: string; name: string; domain: string };

function CreateMember({ onCreated }: { onCreated(): Promise<void> }) {
	const { message } = App.useApp();
	const [form] = Form.useForm<CreateMemberForm>();
	const [busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	const submitting = useRef(false);
	const roles = useMemberOptions<RoleRecord>("roles", true),
		projects = useMemberOptions<ProjectOption>("projects", true);
	const allProjects = Form.useWatch("allProjects", form);
	const viewer = roles.items.find((role) => role.system_key === "viewer")?.id;
	useEffect(() => {
		if (viewer && !form.isFieldTouched("roleIds") && !form.getFieldValue("roleIds")?.length)
			form.setFieldValue("roleIds", [viewer]);
	}, [form, viewer]);
	async function submit(values: CreateMemberForm) {
		if (submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		try {
			await post("/api/users", {
				...values,
				email: values.email.trim(),
				displayName: values.displayName.trim(),
				projectIds: values.allProjects ? [] : (values.projectIds ?? []),
			});
			message.success(`成员「${values.displayName}」已添加`);
			form.resetFields();
			if (viewer) form.setFieldValue("roleIds", [viewer]);
			await onCreated();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "成员创建失败");
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	}
	return (
		<>
			<SectionTitle title="添加成员" description="初始密码至少 12 位。默认不授予任何客户；请选择角色及客户范围。" />
			{error && <Alert type="error" showIcon title={error} />}
			{(roles.error || projects.error) && (
				<Alert
					type="error"
					showIcon
					title={roles.error ?? projects.error}
					action={
						<AntdButton size="small" onClick={() => void Promise.all([roles.reload(), projects.reload()])}>
							重试加载授权选项
						</AntdButton>
					}
				/>
			)}
			{!roles.loading && !roles.error && roles.total === 0 && (
				<Alert
					type="warning"
					showIcon
					title="没有可分配角色"
					description="当前机构可能未授权成员管理功能，或现有角色高于你的权限。请联系系统超管配置，不能通过默认角色绕过授权。"
				/>
			)}
			<Form
				name="create-member"
				form={form}
				layout="vertical"
				className="member-form"
				initialValues={{ allProjects: false, projectIds: [] }}
				onFinish={(values) => void submit(values)}
			>
				<Form.Item
					label="邮箱"
					name="email"
					normalize={(v: string) => v.trim()}
					rules={[
						{ required: true, message: "请输入邮箱" },
						{ type: "email", message: "邮箱格式不正确" },
					]}
				>
					<Input type="email" placeholder="邮箱" autoComplete="off" />
				</Form.Item>
				<Form.Item
					label="姓名"
					name="displayName"
					rules={[{ required: true, whitespace: true, message: "请输入姓名" }]}
				>
					<Input placeholder="姓名" maxLength={160} />
				</Form.Item>
				<Form.Item
					label="角色"
					name="roleIds"
					rules={[{ required: true, type: "array", min: 1, message: "请选择至少一个角色" }]}
				>
					<Select
						mode="multiple"
						placeholder="选择可分配角色"
						loading={roles.loading}
						showSearch={{ filterOption: false, onSearch: roles.setSearch }}
						options={roles.items.map((role) => ({ value: role.id, label: role.name }))}
						onPopupScroll={(e) => {
							const t = e.target as HTMLElement;
							if (t.scrollHeight - t.scrollTop - t.clientHeight < 60) roles.loadMore();
						}}
					/>
				</Form.Item>
				<Form.Item
					label="初始密码"
					name="password"
					rules={[
						{ required: true, message: "请输入初始密码" },
						{ min: 12, max: 1024, message: "密码需为 12–1024 位" },
					]}
				>
					<Input.Password placeholder="至少 12 位" autoComplete="new-password" />
				</Form.Item>
				<Form.Item label="全部客户" name="allProjects" valuePropName="checked">
					<Switch disabled={!projects.allProjectsAllowed} />
				</Form.Item>
				{!allProjects && (
					<Form.Item className="member-form-scope" label="指定客户（留空表示暂不分配客户）" name="projectIds">
						<Select
							mode="multiple"
							placeholder="搜索并选择客户"
							loading={projects.loading}
							showSearch={{ filterOption: false, onSearch: projects.setSearch }}
							options={projects.items.map((project) => ({
								value: project.id,
								label: `${project.name} · ${project.domain}`,
							}))}
							onPopupScroll={(e) => {
								const t = e.target as HTMLElement;
								if (t.scrollHeight - t.scrollTop - t.clientHeight < 60) projects.loadMore();
							}}
						/>
					</Form.Item>
				)}
				<Form.Item className="member-form-submit" label=" ">
					<Button htmlType="submit" busy={busy} disabled={Boolean(roles.error) || !roles.items.length}>
						添加成员
					</Button>
				</Form.Item>
			</Form>
		</>
	);
}

export function UserManagement() {
	const { message } = App.useApp();
	const canManage = usePermission("members.manage");
	const [search, setSearch] = useState("");
	const users = usePaginated<ManagedUser>(
		(page, pageSize) =>
			api<Paginated<ManagedUser>>(
				`/api/users?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), search })}`,
			),
		[search],
	);
	const [error, setError] = useState<string | null>(null),
		[busy, setBusy] = useState<string | null>(null),
		[resetting, setResetting] = useState<ManagedUser | null>(null);
	const [passwordForm] = Form.useForm<{ password: string }>();
	async function action(member: ManagedUser, kind: "disable" | "restore" | "password", password?: string) {
		setBusy(member.id);
		setError(null);
		try {
			if (kind === "disable") await api(`/api/users/${member.id}`, { method: "DELETE" });
			else await post(`/api/users/${member.id}/${kind}`, password ? { password } : {});
			message.success(
				kind === "disable"
					? "成员已停用，登录会话已撤销"
					: kind === "restore"
						? "成员已恢复，需重新登录"
						: "密码已重置，原登录会话已撤销",
			);
			setResetting(null);
			passwordForm.resetFields();
			await users.reload();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "成员操作失败");
		} finally {
			setBusy(null);
		}
	}
	const loadError = users.error instanceof Error ? users.error.message : null;
	return (
		<div className="user-management">
			{(error || loadError) && (
				<Alert
					type="error"
					showIcon
					title={error ?? loadError}
					action={
						<AntdButton size="small" onClick={() => void users.reload().catch(() => undefined)}>
							重试
						</AntdButton>
					}
				/>
			)}
			{canManage ? (
				<CreateMember onCreated={() => users.reload(1)} />
			) : (
				<Alert
					type="info"
					showIcon
					title="当前为成员只读视图"
					description="添加、停用、恢复和重置密码需要「成员管理」权限；角色名称本身不代表实际授权。"
				/>
			)}
			<SectionTitle
				title="成员列表"
				count={users.total || undefined}
				extra={
					<Input.Search
						placeholder="按邮箱或姓名搜索（含停用账号）"
						allowClear
						onSearch={(value) => setSearch(value.trim())}
					/>
				}
			/>
			<Table
				size="middle"
				rowKey="id"
				loading={users.loading}
				pagination={false}
				dataSource={users.items}
				scroll={{ x: 740 }}
				columns={[
					{
						title: "成员",
						key: "member",
						render: (_, member) => (
							<span>
								<b>{member.display_name}</b>
								<br />
								<small>{member.email}</small>
							</span>
						),
					},
					{
						title: "角色",
						key: "roles",
						render: (_, member) =>
							member.is_super_admin ? "系统超管" : member.roles.map((role) => role.name).join("、") || "未分配角色",
					},
					{
						title: "客户范围",
						key: "scope",
						render: (_, member) =>
							member.is_super_admin || member.all_projects ? "全部客户" : `${member.project_ids.length} 个指定客户`,
					},
					{ title: "状态", key: "status", render: (_, member) => <Tag>{member.disabled_at ? "已停用" : "有效"}</Tag> },
					{
						title: "操作",
						key: "actions",
						render: (_, member) =>
							!canManage || !member.can_manage ? (
								<small className="muted">{member.is_super_admin ? "系统账号受保护" : "无权操作或当前账号"}</small>
							) : (
								<Space wrap>
									<Popconfirm
										title={`${member.disabled_at ? "恢复" : "停用"}成员「${member.display_name}」？`}
										description="旧登录会话不会恢复。"
										onConfirm={() => action(member, member.disabled_at ? "restore" : "disable")}
									>
										<Button
											variant={member.disabled_at ? "secondary" : "danger"}
											size="small"
											busy={busy === member.id}
										>
											{member.disabled_at ? "恢复" : "停用"}
										</Button>
									</Popconfirm>
									<Button
										variant="secondary"
										size="small"
										disabled={Boolean(busy)}
										onClick={() => {
											setResetting(member);
											passwordForm.resetFields();
										}}
									>
										重置密码
									</Button>
								</Space>
							),
					},
				]}
			/>
			<Pagination {...users} onPage={users.setPage} onPageSize={users.setPageSize} />
			<Modal
				title={`重置「${resetting?.display_name ?? ""}」的密码`}
				open={Boolean(resetting)}
				onCancel={() => setResetting(null)}
				onOk={() => passwordForm.submit()}
				confirmLoading={Boolean(busy)}
				destroyOnHidden
			>
				{error && <Alert type="error" title={error} />}
				<Form
					name="reset-member-password"
					form={passwordForm}
					layout="vertical"
					onFinish={(values) => {
						if (resetting) void action(resetting, "password", values.password);
					}}
				>
					<Form.Item
						name="password"
						label="新密码"
						rules={[{ required: true }, { min: 12, max: 1024, message: "密码需为 12–1024 位" }]}
					>
						<Input.Password autoComplete="new-password" />
					</Form.Item>
				</Form>
			</Modal>
		</div>
	);
}
