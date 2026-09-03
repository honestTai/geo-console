import { IconPlus } from "@tabler/icons-react";
import { Alert, Button as AntdButton, App, Form, Input, Modal, Popconfirm } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { OrganizationSummary, Paginated, UserIdentity } from "../types";
import { FilterBar, IdChip, Pagination } from "../ui/primitives";
import { Page } from "./Page";

type CreateOrganizationValues = { name: string };

function CreateOrganization({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(): void }) {
	const { message } = App.useApp();
	const [form] = Form.useForm<CreateOrganizationValues>();
	const [busy, setBusy] = useState(false);
	async function submit(values: CreateOrganizationValues) {
		setBusy(true);
		try {
			await post("/api/organizations", { name: values.name.trim() });
			message.success(`机构「${values.name.trim()}」已创建`);
			onCreated();
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "机构创建失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Modal
			title="新建机构"
			open={open}
			onCancel={onClose}
			destroyOnHidden
			mask={{ closable: false }}
			footer={[
				<AntdButton key="cancel" onClick={onClose}>
					取消
				</AntdButton>,
				<AntdButton key="submit" type="primary" loading={busy} onClick={() => form.submit()}>
					创建机构
				</AntdButton>,
			]}
		>
			<p className="muted">
				新机构会拥有独立的项目、证据、模型凭据、问题库、报告、成员和审计日志，创建后可随时进入配置。
			</p>
			<Form<CreateOrganizationValues> form={form} layout="vertical" onFinish={submit} requiredMark="optional">
				<Form.Item
					name="name"
					label="机构名称"
					rules={[{ required: true, whitespace: true, message: "请输入机构名称" }]}
				>
					<Input autoFocus placeholder="公司或团队全称" maxLength={80} />
				</Form.Item>
			</Form>
		</Modal>
	);
}

export function OrganizationManagement({
	user,
	onIdentityChange,
}: {
	user: UserIdentity;
	onIdentityChange(user: UserIdentity): void;
}) {
	const { message } = App.useApp();
	const [creating, setCreating] = useState(false);
	const [search, setSearch] = useState("");
	const organizations = usePaginated<OrganizationSummary>(
		(page, pageSize) => {
			const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
			if (search.trim()) params.set("search", search.trim());
			return api<Paginated<OrganizationSummary>>(`/api/organizations?${params}`);
		},
		[search],
	);
	const [suspending, setSuspending] = useState<OrganizationSummary | null>(null);
	const [suspensionReason, setSuspensionReason] = useState("");
	const [error, setError] = useState<string | null>(null);
	async function select(organizationId: string) {
		const result = await post<{ user: UserIdentity }>("/api/organizations/select", { organizationId });
		onIdentityChange(result.user);
	}
	async function updateStatus(
		organization: OrganizationSummary,
		status: "active" | "suspended",
		reason: string | null = null,
	) {
		setError(null);
		try {
			await put(`/api/organizations/${organization.id}/status`, { status, reason });
			message.success(status === "suspended" ? "机构已封禁" : "机构已解封");
			setSuspending(null);
			setSuspensionReason("");
			await organizations.reload();
		} catch (reasonValue) {
			setError(reasonValue instanceof Error ? reasonValue.message : "机构状态更新失败");
		}
	}
	return (
		<Page
			className="organization-management"
			eyebrow="系统管理"
			title="多租户管理"
			description="每个机构的客户、证据、密钥、成员与日志相互隔离。"
			extra={
				<Button icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
					新建机构
				</Button>
			}
		>
			{error && <Alert type="error" showIcon title={error} />}
			<FilterBar extra={<span className="muted">{organizations.total ? `${organizations.total} 个机构` : ""}</span>}>
				<Input
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="搜索机构名称或 ID"
					allowClear
				/>
			</FilterBar>
			<div className="organization-list">
				{organizations.items.map((organization) => (
					<article className={organization.id === user.organizationId ? "active" : ""} key={organization.id}>
						<div>
							<h3>{organization.name}</h3>
							<IdChip value={organization.id} label="机构" length={12} />
							<p>
								{organization.project_count} 个项目 · {organization.user_count} 位有效成员
							</p>
							{organization.suspended_at && (
								<small className="organization-suspended">
									已封禁：{organization.suspended_reason || "未填写原因"}
								</small>
							)}
						</div>
						<div className="actions">
							<Button
								variant="secondary"
								disabled={organization.id === user.organizationId}
								onClick={() => void select(organization.id)}
							>
								{organization.id === user.organizationId ? "当前机构" : "进入机构"}
							</Button>
							{organization.suspended_at ? (
								<Popconfirm
									title={`解封「${organization.name}」？`}
									okText="解封"
									cancelText="取消"
									onConfirm={() => void updateStatus(organization, "active")}
								>
									<span>
										<Button variant="secondary">解封</Button>
									</span>
								</Popconfirm>
							) : (
								<Button variant="danger" onClick={() => setSuspending(organization)}>
									封禁
								</Button>
							)}
						</div>
					</article>
				))}
			</div>
			<Pagination {...organizations} onPage={(page) => void organizations.reload(page)} />
			<CreateOrganization
				open={creating}
				onClose={() => setCreating(false)}
				onCreated={() => {
					setCreating(false);
					void organizations.reload();
				}}
			/>
			<Modal
				title={`封禁 ${suspending?.name ?? ""}`}
				open={Boolean(suspending)}
				okText="确认封禁"
				okButtonProps={{ danger: true, disabled: !suspensionReason.trim() }}
				cancelText="取消"
				onCancel={() => setSuspending(null)}
				onOk={() => suspending && void updateStatus(suspending, "suspended", suspensionReason)}
			>
				<p>封禁会立即撤销该机构普通用户的会话，超管仍可进入处理。</p>
				<Input.TextArea
					value={suspensionReason}
					onChange={(event) => setSuspensionReason(event.target.value)}
					rows={4}
					placeholder="填写封禁原因"
				/>
			</Modal>
		</Page>
	);
}
