import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Alert, App, Checkbox, Collapse, Input, List, Popconfirm, Switch, Table, Tabs, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import type { ManagedUser, Paginated, PermissionRecord, ProjectSummary, RoleRecord, UserIdentity } from "../types";
import { Pagination } from "../ui/primitives";
import { Page } from "./Page";
import "./RbacManagement.css";

export function PermissionChecklist({
	permissions,
	selected,
	onChange,
}: {
	permissions: PermissionRecord[];
	selected: string[];
	onChange(keys: string[]): void;
}) {
	const groups = useMemo(() => {
		const values = new Map<string, PermissionRecord[]>();
		for (const permission of permissions) {
			const group = values.get(permission.group_label) ?? [];
			group.push(permission);
			values.set(permission.group_label, group);
		}
		return [...values.entries()];
	}, [permissions]);
	const toggleGroup = (groupKeys: string[], keys: string[]) =>
		onChange([...selected.filter((key) => !groupKeys.includes(key)), ...keys]);
	return (
		<Collapse
			size="small"
			className="permission-groups"
			defaultActiveKey={groups
				.filter(([, items]) => items.some((permission) => selected.includes(permission.key)))
				.map(([group]) => group)}
			items={groups.map(([group, items]) => {
				const groupKeys = items.map((permission) => permission.key);
				const checkedCount = items.filter((permission) => selected.includes(permission.key)).length;
				return {
					key: group,
					label: `${group}（已选 ${checkedCount}/${items.length}）`,
					children: (
						<Checkbox.Group
							className="permission-checkboxes"
							value={selected.filter((key) => groupKeys.includes(key))}
							onChange={(keys) => toggleGroup(groupKeys, keys as string[])}
							options={items.map((permission) => ({
								value: permission.key,
								label: (
									<span>
										{permission.label}{" "}
										<Typography.Text type="secondary">{permission.kind === "page" ? "页面" : "功能"}</Typography.Text>
									</span>
								),
							}))}
						/>
					),
				};
			})}
		/>
	);
}

export function RbacManagement({ user }: { user: UserIdentity }) {
	const { message } = App.useApp();
	const [tab, setTab] = useState<"organization" | "roles" | "users">("organization");
	const [permissions, setPermissions] = useState<PermissionRecord[]>([]);
	const [organizationKeys, setOrganizationKeys] = useState<string[]>([]);
	const [rolesPage, setRolesPage] = useState<Paginated<RoleRecord>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const [usersPage, setUsersPage] = useState<Paginated<ManagedUser>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const [projectsPage, setProjectsPage] = useState<Paginated<ProjectSummary>>({
		items: [],
		page: 1,
		pageSize: 10,
		total: 0,
		totalPages: 1,
	});
	const [roleDraft, setRoleDraft] = useState<{
		id: string | null;
		name: string;
		description: string;
		permissionKeys: string[];
	}>({
		id: null,
		name: "",
		description: "",
		permissionKeys: [],
	});
	const [selectedUser, setSelectedUser] = useState<ManagedUser | null>(null);
	const [userRoleIds, setUserRoleIds] = useState<string[]>([]);
	const [allProjects, setAllProjects] = useState(true);
	const [projectIds, setProjectIds] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadCatalog = useCallback(async () => {
		const result = await api<{ permissions: PermissionRecord[]; organizationPermissionKeys: string[] }>(
			"/api/rbac/catalog",
		);
		setPermissions(result.permissions);
		setOrganizationKeys(result.organizationPermissionKeys);
	}, []);
	const loadRoles = useCallback(
		async (page = rolesPage.page) => {
			const result = await api<Paginated<RoleRecord>>(`/api/rbac/roles?page=${page}&pageSize=${rolesPage.pageSize}`);
			setRolesPage(result);
		},
		[rolesPage.page, rolesPage.pageSize],
	);
	const loadUsers = useCallback(
		async (page = usersPage.page) => {
			const result = await api<Paginated<ManagedUser>>(`/api/users?page=${page}&pageSize=${usersPage.pageSize}`);
			setUsersPage(result);
		},
		[usersPage.page, usersPage.pageSize],
	);
	const loadProjectsForScope = useCallback(
		async (page = projectsPage.page) => {
			const result = await api<Paginated<ProjectSummary>>(
				`/api/projects?page=${page}&pageSize=${projectsPage.pageSize}`,
			);
			setProjectsPage(result);
		},
		[projectsPage.page, projectsPage.pageSize],
	);
	const reload = useCallback(async () => {
		setError(null);
		try {
			await Promise.all([loadCatalog(), loadRoles(), loadUsers(), loadProjectsForScope()]);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "权限配置加载失败");
		}
	}, [loadCatalog, loadProjectsForScope, loadRoles, loadUsers]);
	useEffect(() => {
		void reload();
	}, [reload]);
	const rolePermissions = permissions.filter(
		(permission) => !permission.system_only && organizationKeys.includes(permission.key),
	);

	async function saveOrganizationPermissions() {
		setBusy(true);
		setError(null);
		try {
			await put(`/api/organizations/${user.organizationId}/permissions`, { permissionKeys: organizationKeys });
			message.success("机构授权已保存");
			await reload();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "机构授权保存失败");
		} finally {
			setBusy(false);
		}
	}

	async function saveRole() {
		setBusy(true);
		setError(null);
		try {
			const payload = {
				name: roleDraft.name,
				description: roleDraft.description || null,
				permissionKeys: roleDraft.permissionKeys,
			};
			if (roleDraft.id) await put(`/api/rbac/roles/${roleDraft.id}`, payload);
			else await post("/api/rbac/roles", payload);
			message.success("角色已保存");
			setRoleDraft({ id: null, name: "", description: "", permissionKeys: [] });
			await loadRoles(1);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "角色保存失败");
		} finally {
			setBusy(false);
		}
	}

	function editUserAccess(member: ManagedUser) {
		setSelectedUser(member);
		setUserRoleIds(member.roles.map((role) => role.id));
		setAllProjects(member.all_projects);
		setProjectIds(member.project_ids);
	}

	async function saveUserAccess() {
		if (!selectedUser) return;
		setBusy(true);
		setError(null);
		try {
			await put(`/api/users/${selectedUser.id}/access`, { roleIds: userRoleIds, allProjects, projectIds });
			message.success("用户授权已保存");
			await loadUsers();
			setSelectedUser(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "用户授权保存失败");
		} finally {
			setBusy(false);
		}
	}

	async function deleteRole(role: RoleRecord) {
		setError(null);
		try {
			await api(`/api/rbac/roles/${role.id}`, { method: "DELETE" });
			message.success(`角色「${role.name}」已删除`);
			await loadRoles();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "角色删除失败");
		}
	}

	return (
		<Page
			className="rbac-management"
			eyebrow="动态 RBAC"
			title="机构、角色、用户与客户范围"
			description="最终权限 = 机构授权上限 ∩ 用户全部角色的权限并集，并继续受客户范围限制。"
		>
			{error && <Alert type="error" showIcon message={error} />}
			<Tabs
				activeKey={tab}
				onChange={(key) => setTab(key as typeof tab)}
				items={[
					{
						key: "organization",
						label: "机构授权",
						children: (
							<div className="rbac-section">
								<header>
									<div>
										<h3>{user.organizationName}</h3>
										<p>超管决定该机构最多可使用的页面和功能；角色不能越过这里的上限。</p>
									</div>
									<Button busy={busy} onClick={() => void saveOrganizationPermissions()}>
										保存机构授权
									</Button>
								</header>
								<PermissionChecklist
									permissions={permissions.filter((permission) => !permission.system_only)}
									selected={organizationKeys}
									onChange={setOrganizationKeys}
								/>
							</div>
						),
					},
					{
						key: "roles",
						label: "角色权限",
						children: (
							<div className="rbac-split">
								<section className="rbac-list">
									<header>
										<h3>机构角色</h3>
										<Button
											variant="secondary"
											icon={<IconPlus size={16} />}
											onClick={() => setRoleDraft({ id: null, name: "", description: "", permissionKeys: [] })}
										>
											新建角色
										</Button>
									</header>
									<List
										size="small"
										className="rbac-role-list"
										dataSource={rolesPage.items}
										renderItem={(role) => (
											<List.Item
												className={roleDraft.id === role.id ? "active" : undefined}
												onClick={() =>
													setRoleDraft({
														id: role.id,
														name: role.name,
														description: role.description ?? "",
														permissionKeys: role.permission_keys,
													})
												}
												actions={
													role.is_system
														? undefined
														: [
																<Popconfirm
																	key="delete"
																	title={`删除角色「${role.name}」？`}
																	okText="删除"
																	cancelText="取消"
																	onConfirm={() => void deleteRole(role)}
																>
																	<span>
																		<Button variant="ghost" icon={<IconTrash size={15} />}>
																			删除
																		</Button>
																	</span>
																</Popconfirm>,
															]
												}
											>
												<List.Item.Meta
													title={role.name}
													description={`${role.user_count} 位用户 · ${role.permission_keys.length} 项权限`}
												/>
											</List.Item>
										)}
									/>
									<Pagination {...rolesPage} onPage={(page) => void loadRoles(page)} />
								</section>
								<section className="role-editor">
									<h3>{roleDraft.id ? "编辑角色" : "新建角色"}</h3>
									<Input
										value={roleDraft.name}
										onChange={(event) => setRoleDraft({ ...roleDraft, name: event.target.value })}
										placeholder="角色名称"
									/>
									<Input.TextArea
										value={roleDraft.description}
										onChange={(event) => setRoleDraft({ ...roleDraft, description: event.target.value })}
										placeholder="角色说明"
										rows={3}
									/>
									<PermissionChecklist
										permissions={rolePermissions}
										selected={roleDraft.permissionKeys}
										onChange={(permissionKeys) => setRoleDraft({ ...roleDraft, permissionKeys })}
									/>
									<Button busy={busy} disabled={!roleDraft.name.trim()} onClick={() => void saveRole()}>
										保存角色
									</Button>
								</section>
							</div>
						),
					},
					{
						key: "users",
						label: "用户与客户范围",
						children: (
							<div className="rbac-split">
								<section className="rbac-list">
									<h3>机构用户</h3>
									<List
										size="small"
										className="rbac-role-list"
										dataSource={usersPage.items}
										renderItem={(member) => (
											<List.Item
												className={selectedUser?.id === member.id ? "active" : undefined}
												onClick={member.is_super_admin ? undefined : () => editUserAccess(member)}
											>
												<List.Item.Meta
													title={member.display_name}
													description={member.roles.map((role) => role.name).join("、") || "未分配角色"}
												/>
											</List.Item>
										)}
									/>
									<Pagination {...usersPage} onPage={(page) => void loadUsers(page)} />
								</section>
								<section className="role-editor">
									<h3>{selectedUser ? `${selectedUser.display_name} 的访问范围` : "选择一个用户"}</h3>
									{selectedUser && (
										<>
											<h4>分配角色</h4>
											<Checkbox.Group
												className="permission-checkboxes"
												value={userRoleIds}
												onChange={(keys) => setUserRoleIds(keys as string[])}
												options={rolesPage.items.map((role) => ({ value: role.id, label: role.name }))}
											/>
											<div className="scope-toggle">
												<span>可访问机构下全部客户</span>
												<Switch checked={allProjects} onChange={setAllProjects} />
											</div>
											{!allProjects && (
												<>
													<Table
														size="small"
														rowKey="id"
														pagination={false}
														dataSource={projectsPage.items}
														columns={[
															{ title: "客户", dataIndex: "name" },
															{ title: "域名", dataIndex: "domain" },
														]}
														rowSelection={{
															selectedRowKeys: projectIds,
															onChange: (keys) => setProjectIds(keys as string[]),
														}}
													/>
													<Pagination {...projectsPage} onPage={(page) => void loadProjectsForScope(page)} />
												</>
											)}
											<Button busy={busy} onClick={() => void saveUserAccess()}>
												保存用户授权
											</Button>
										</>
									)}
								</section>
							</div>
						),
					},
				]}
			/>
		</Page>
	);
}
