import { IconCode, IconHelpCircle, IconRefresh } from "@tabler/icons-react";
import { Alert, App, Form, Input, Modal, Space, Tag } from "antd";
import { useEffect, useState } from "react";
import { Button } from "../access";
import { post } from "../api";
import type { UserIdentity } from "../types";
import "./Login.css";

type LoginFormValues = { email: string; password: string; organizationId?: string };

export function Login({ error, onLogin }: { error: string | null; onLogin(user: UserIdentity): void }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(error);
	useEffect(() => {
		setMessage(error);
	}, [error]);
	async function submit(values: LoginFormValues) {
		setBusy(true);
		setMessage(null);
		try {
			const result = await post<{ user: UserIdentity }>("/api/auth/login", {
				email: values.email,
				password: values.password,
				organizationId: values.organizationId || undefined,
			});
			onLogin(result.user);
		} catch (reason) {
			setMessage(reason instanceof Error ? reason.message : "登录失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<main className="login-page">
			<Form<LoginFormValues>
				name="account-login"
				layout="vertical"
				className="login-panel"
				onFinish={submit}
				requiredMark={false}
			>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>机构云端工作台</small>
					</div>
				</div>
				<div>
					<h1>登录机构控制台</h1>
					<p>监测密钥、客户证据和报告仅对机构成员开放。</p>
				</div>
				<Form.Item
					name="email"
					label="邮箱"
					rules={[
						{ required: true, message: "请输入邮箱" },
						{ type: "email", message: "邮箱格式不正确" },
					]}
				>
					<Input autoComplete="username" />
				</Form.Item>
				<Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
					<Input.Password autoComplete="current-password" />
				</Form.Item>
				<Form.Item name="organizationId" label="机构 ID（同邮箱属于多个机构时填写）">
					<Input autoComplete="organization" />
				</Form.Item>
				{message && <Alert type="error" title={message} showIcon />}
				<Button htmlType="submit" busy={busy} block>
					登录
				</Button>
				<Button variant="link" icon={<IconHelpCircle size={16} />} href="/help/" target="_blank" block>
					查看操作手册
				</Button>
				<Button
					variant="link"
					icon={<IconCode size={16} />}
					href="https://github.com/honestTai/geo-console/releases/tag/v0.1.0"
					target="_blank"
					rel="noopener noreferrer"
					block
				>
					获取本版本源码（AGPL-3.0）
				</Button>
			</Form>
		</main>
	);
}

export function AccountControl({ user, onLogout }: { user: UserIdentity; onLogout(): Promise<void> }) {
	return (
		<div className="account-control">
			<Space size={12} align="center" wrap>
				<div>
					<b>{user.displayName}</b>
					<small>
						{user.isSuperAdmin ? "系统超管" : user.roles.map((role) => role.name).join("、") || "未分配角色"} ·{" "}
						{user.organizationName}
					</small>
				</div>
				{user.organizationSuspended && <Tag>已封禁</Tag>}
				<DesktopUpdateButton />
				<Button
					variant="link"
					icon={<IconCode size={16} />}
					href="https://github.com/honestTai/geo-console/releases/tag/v0.1.0"
					target="_blank"
					rel="noopener noreferrer"
				>
					源码
				</Button>
				{!user.localBypass && <ChangePassword />}
				<Button variant="secondary" onClick={() => void onLogout()}>
					退出
				</Button>
			</Space>
		</div>
	);
}

function ChangePassword() {
	const { message } = App.useApp();
	const [open, setOpen] = useState(false),
		[busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirmation: string }>();
	async function submit(values: { currentPassword: string; newPassword: string }) {
		setBusy(true);
		setError(null);
		try {
			await post("/api/auth/password", { currentPassword: values.currentPassword, newPassword: values.newPassword });
			message.success("密码已修改，其他登录会话已退出");
			setOpen(false);
			form.resetFields();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "密码修改失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Button
				variant="secondary"
				onClick={() => {
					setOpen(true);
					setError(null);
					form.resetFields();
				}}
			>
				修改密码
			</Button>
			<Modal
				title="修改自己的密码"
				open={open}
				onCancel={() => setOpen(false)}
				onOk={() => form.submit()}
				confirmLoading={busy}
				destroyOnHidden
			>
				<Form name="change-own-password" form={form} layout="vertical" onFinish={(values) => void submit(values)}>
					<Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
						<Input.Password autoComplete="current-password" />
					</Form.Item>
					<Form.Item
						name="newPassword"
						label="新密码"
						rules={[{ required: true }, { min: 12, max: 1024, message: "新密码需为 12–1024 位" }]}
					>
						<Input.Password autoComplete="new-password" />
					</Form.Item>
					<Form.Item
						name="confirmation"
						label="确认新密码"
						dependencies={["newPassword"]}
						rules={[
							{ required: true },
							({ getFieldValue }) => ({
								validator: (_, value) =>
									value === getFieldValue("newPassword")
										? Promise.resolve()
										: Promise.reject(new Error("两次新密码不一致")),
							}),
						]}
					>
						<Input.Password autoComplete="new-password" />
					</Form.Item>
				</Form>
				{error && <Alert type="error" showIcon title={error} />}
			</Modal>
		</>
	);
}

export function DesktopUpdateButton() {
	const isDesktop = navigator.userAgent.includes("ZZGeoDesktop/");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("检查更新");
	if (!isDesktop) return null;
	async function update() {
		setBusy(true);
		try {
			const [{ check }, { relaunch }] = await Promise.all([
				import("@tauri-apps/plugin-updater"),
				import("@tauri-apps/plugin-process"),
			]);
			const next = await check({ timeout: 30_000 });
			if (!next) {
				setStatus("已是最新版本");
				return;
			}
			setStatus(`正在更新至 ${next.version}`);
			await next.downloadAndInstall();
			await relaunch();
		} catch (reason) {
			setStatus(reason instanceof Error ? "更新检查失败" : "无法更新");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Button variant="secondary" busy={busy} icon={<IconRefresh size={15} />} onClick={() => void update()}>
			{status}
		</Button>
	);
}
