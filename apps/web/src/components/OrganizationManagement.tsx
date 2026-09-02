import { IconPlus } from "@tabler/icons-react";
import { Alert, App, Input, Modal, Popconfirm } from "antd";
import { useState } from "react";
import { Button } from "../access";
import { api, post, put } from "../api";
import { usePaginated } from "../hooks/usePagination";
import type { OrganizationSummary, Paginated, UserIdentity } from "../types";
import { Pagination } from "../ui/primitives";

export function OrganizationManagement({
	user,
	onIdentityChange,
}: {
	user: UserIdentity;
	onIdentityChange(user: UserIdentity): void;
}) {
	const { message } = App.useApp();
	const [name, setName] = useState("");
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
	async function create() {
		setError(null);
		try {
			await post("/api/organizations", { name });
			message.success(`机构「${name.trim()}」已创建`);
			setName("");
			await organizations.reload();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "机构创建失败");
		}
	}
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
		<section className="organization-management">
			<div className="overview-head">
				<div>
					<span className="eyebrow">系统超管</span>
					<h2>多租户管理</h2>
					<p className="muted">每个机构拥有独立的项目、证据、模型凭据、问题库、报告、成员和审计日志。</p>
				</div>
				<div className="organization-create">
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="搜索机构名称或 ID"
						allowClear
					/>
					<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="新机构名称" />
					<Button icon={<IconPlus size={16} />} disabled={!name.trim()} onClick={() => void create()}>
						创建机构
					</Button>
				</div>
			</div>
			{error && <Alert type="error" showIcon message={error} />}
			<div className="organization-list">
				{organizations.items.map((organization) => (
					<article className={organization.id === user.organizationId ? "active" : ""} key={organization.id}>
						<div>
							<h3>{organization.name}</h3>
							<code>{organization.id}</code>
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
								进入机构
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
		</section>
	);
}
