import { IconKey } from "@tabler/icons-react";
import { Alert, App, Form, Input, Popconfirm, Select, Table, Tag } from "antd";
import { useEffect, useState } from "react";
import { Button } from "../access";
import { api, post } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { ManagedUser, Paginated, RoleRecord } from "../types";
import { Pagination } from "../ui/primitives";
import { Page } from "./Page";

export function Members({ localBypass }: { localBypass: boolean }) {
	return (
		<Page
			eyebrow="机构成员"
			title="角色与访问状态"
			description="管理员维护机构成员、角色和访问状态；成员停用后其现有会话会被撤销。"
		>
			{localBypass ? (
				<div className="settings-band member-mode-note">
					<div>
						<IconKey size={24} />
						<h3>本机免登录开发模式</h3>
						<p>配置 GEO_ADMIN_EMAIL 和 GEO_ADMIN_PASSWORD 后重启，即可启用管理员、分析师和只读成员管理。</p>
					</div>
				</div>
			) : (
				<UserManagement />
			)}
		</Page>
	);
}

type CreateMemberForm = {
	email: string;
	displayName: string;
	roleId: string;
	password: string;
};

export function UserManagement() {
	const { message } = App.useApp();
	const [form] = Form.useForm<CreateMemberForm>();
	const users = usePaginated<ManagedUser>(
		(page, pageSize) => api<Paginated<ManagedUser>>(`/api/users?page=${page}&pageSize=${pageSize}`),
		[],
	);
	const [roles, setRoles] = useState<RoleRecord[]>([]);
	const [error, setError] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: mirrors the original combined effect's [load] dependency so roles refresh whenever the users query reloads.
	useEffect(() => {
		void api<Paginated<RoleRecord>>("/api/rbac/roles?page=1&pageSize=100")
			.then((result) => {
				setRoles(result.items);
				const defaultRoleId = form.getFieldValue("roleId") || result.items[0]?.id || "";
				form.setFieldsValue({ roleId: defaultRoleId });
			})
			.catch(() => setRoles([]));
	}, [users.reload, form]);
	async function create(values: CreateMemberForm) {
		setError(null);
		try {
			await post("/api/users", { ...values, roleIds: values.roleId ? [values.roleId] : [] });
			message.success(`成员「${values.displayName}」已添加`);
			form.setFieldsValue({ email: "", displayName: "", password: "", roleId: roles[0]?.id ?? "" });
			await users.reload();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "成员创建失败");
		}
	}
	async function disableUser(member: ManagedUser) {
		setError(null);
		try {
			await api(`/api/users/${member.id}`, { method: "DELETE" });
			message.success(`成员「${member.display_name}」已停用`);
			await users.reload();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "成员停用失败");
		}
	}
	return (
		<div className="user-management">
			{error && <Alert type="error" showIcon message={error} />}
			<Form form={form} layout="inline" onFinish={(values) => void create(values)}>
				<Form.Item
					name="email"
					rules={[
						{ required: true, message: "请输入邮箱" },
						{ type: "email", message: "邮箱格式不正确" },
					]}
				>
					<Input type="email" placeholder="邮箱" />
				</Form.Item>
				<Form.Item name="displayName" rules={[{ required: true, message: "请输入姓名" }]}>
					<Input placeholder="姓名" />
				</Form.Item>
				<Form.Item name="roleId" rules={[{ required: true, message: "请选择角色" }]}>
					<Select placeholder="选择角色" options={roles.map((role) => ({ value: role.id, label: role.name }))} />
				</Form.Item>
				<Form.Item
					name="password"
					rules={[
						{ required: true, message: "请输入初始密码" },
						{ min: 12, message: "密码至少12位" },
					]}
				>
					<Input.Password placeholder="至少12位初始密码" />
				</Form.Item>
				<Form.Item>
					<Button permission="members.manage" type="submit">
						添加成员
					</Button>
				</Form.Item>
			</Form>
			<Table
				size="small"
				rowKey="id"
				loading={users.loading}
				pagination={false}
				dataSource={users.items}
				columns={[
					{
						title: "成员",
						key: "member",
						render: (_, member) => (
							<span>
								<b>{member.display_name}</b> <small className="muted">{member.email}</small>
							</span>
						),
					},
					{
						title: "角色",
						key: "roles",
						render: (_, member) => member.roles.map((role) => role.name).join("、") || "未分配角色",
					},
					{
						title: "状态",
						key: "status",
						render: (_, member) => (member.disabled_at ? <Tag>已停用</Tag> : <Tag>有效</Tag>),
					},
					{
						title: "操作",
						key: "actions",
						render: (_, member) => (
							<Popconfirm
								title={`停用「${member.display_name}」？`}
								description="停用后其现有会话会被撤销。"
								okText="停用"
								cancelText="取消"
								onConfirm={() => void disableUser(member)}
							>
								<span>
									<Button permission="members.manage" variant="ghost" disabled={Boolean(member.disabled_at)}>
										停用
									</Button>
								</span>
							</Popconfirm>
						),
					},
				]}
			/>
			<Pagination {...users} onPage={(page) => void users.reload(page)} onPageSize={users.setPageSize} />
		</div>
	);
}
