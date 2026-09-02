import { IconChevronRight, IconPlus, IconSearch, IconSettings } from "@tabler/icons-react";
import { App as AntdApp, Button as AntdButton, Card, Form, Input, Modal, Space, Tag, Typography } from "antd";
import { type ReactNode, useState } from "react";
import { Button, usePermission } from "../access";
import { post } from "../api";
import type { Paginated, ProjectSummary, View } from "../types";
import { managementViews } from "../types";
import { Empty, FilterBar, Notice, Pagination, shortDate } from "../ui/primitives";
import "./ProjectHome.css";

export function ProjectHome({
	account,
	projects,
	navigation,
	pagination,
	search,
	onSearch,
	onPage,
	onPageSize,
	onOpen,
	onManage,
	onCreate,
	creating,
	onClose,
	onCreated,
	error,
}: {
	account: ReactNode;
	projects: ProjectSummary[];
	navigation: Array<{ id: View; label: string }>;
	pagination: Paginated<ProjectSummary>;
	search: string;
	onSearch(value: string): void;
	onPage(page: number): void;
	onPageSize(pageSize: number): void;
	onOpen(id: string): void;
	onManage(view: View): void;
	onCreate(): void;
	creating: boolean;
	onClose(): void;
	onCreated(id: string): void;
	error: string | null;
}) {
	const managementEntry = navigation.find((item) => managementViews.includes(item.id));
	const canCreate = usePermission("project.create");
	return (
		<main className="project-home">
			<header>
				<div className="brand">
					<span className="brand-mark">Z</span>
					<div>
						<strong>ZZ Geo</strong>
						<small>真实 AI 可见度工作台</small>
					</div>
				</div>
				<div className="home-actions">
					<Space size="middle" wrap>
						{managementEntry && (
							<Button
								variant="secondary"
								icon={<IconSettings size={17} />}
								onClick={() => onManage(managementEntry.id)}
							>
								机构管理
							</Button>
						)}
						<Button permission="project.create" icon={<IconPlus size={17} />} onClick={onCreate}>
							新建客户
						</Button>
						{account}
					</Space>
				</div>
			</header>
			<section className="home-title">
				<span className="eyebrow">客户项目</span>
				<h1>从一个真实客户开始</h1>
				<p>建档、真实采集、证据诊断、整改和同条件复测都保存在同一个项目中。</p>
			</section>
			<FilterBar
				extra={<span className="project-home-count">{pagination.total ? `共 ${pagination.total} 个客户` : ""}</span>}
			>
				<Input
					className="project-home-search"
					allowClear
					prefix={<IconSearch size={16} />}
					value={search}
					onChange={(event) => onSearch(event.target.value)}
					placeholder="按客户名或域名筛选"
				/>
			</FilterBar>
			{error && <Notice type="error" message={error} />}
			{projects.length === 0 ? (
				<Empty
					title="还没有客户项目"
					detail="输入客户与官网，系统将先读取真实网站，再生成待人工确认的竞品和购买问题。"
					action={
						<Button permission="project.create" icon={<IconPlus size={17} />} onClick={onCreate}>
							新建第一个客户
						</Button>
					}
				/>
			) : (
				<div className="project-grid">
					{projects.map((project) => (
						<Card key={project.id} className="project-home-card" hoverable onClick={() => onOpen(project.id)}>
							<div className="project-home-card-head">
								<Tag>{project.status === "active" ? "运行中" : "待建档"}</Tag>
								<IconChevronRight className="card-arrow" size={20} />
							</div>
							<Typography.Title level={5} className="project-home-card-name" ellipsis={{ tooltip: project.name }}>
								{project.name}
							</Typography.Title>
							<Typography.Text type="secondary">{project.domain}</Typography.Text>
							<div className="project-home-card-stats">
								<div>
									<span>地区</span>
									<b>{project.region}</b>
								</div>
								<div>
									<span>批次</span>
									<b>{project.batch_count ?? 0}</b>
								</div>
								<div>
									<span>最近监测</span>
									<b>{shortDate(project.last_batch_at)}</b>
								</div>
							</div>
						</Card>
					))}
					{canCreate && (
						<Card className="project-home-card project-home-card-new" onClick={onCreate}>
							<IconPlus size={30} strokeWidth={1.6} />
							<Typography.Text strong>新建客户</Typography.Text>
							<Typography.Text type="secondary">录入客户与官网，开始真实采集</Typography.Text>
						</Card>
					)}
				</div>
			)}
			<Pagination {...pagination} onPage={onPage} onPageSize={onPageSize} />
			<CreateProject open={creating} onClose={onClose} onCreated={onCreated} />
		</main>
	);
}

type CreateProjectValues = {
	name: string;
	websiteUrl: string;
	region: string;
	language: string;
	industry: string;
	businessFocus?: string;
	aliases?: string;
	knownCompetitors?: string;
};

function splitList(value: string | undefined): string[] {
	return String(value || "")
		.split(/[，,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function CreateProject({
	open,
	onClose,
	onCreated,
}: {
	open: boolean;
	onClose(): void;
	onCreated(id: string): void;
}) {
	const [form] = Form.useForm<CreateProjectValues>();
	const [busy, setBusy] = useState(false);
	const { message } = AntdApp.useApp();
	async function submit(values: CreateProjectValues) {
		setBusy(true);
		try {
			const result = await post<{ id: string }>("/api/projects", {
				name: values.name,
				websiteUrl: values.websiteUrl,
				region: values.region,
				language: values.language,
				industry: values.industry,
				businessFocus: values.businessFocus || null,
				aliases: splitList(values.aliases),
				knownCompetitors: splitList(values.knownCompetitors),
			});
			onCreated(result.id);
		} catch (reason) {
			message.error(reason instanceof Error ? reason.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Modal
			className="project-home-modal"
			open={open}
			onCancel={onClose}
			width={720}
			destroyOnHidden
			maskClosable={false}
			title={
				<div>
					<span className="eyebrow">客户建档</span>
					<div className="project-home-modal-title">新建真实客户项目</div>
				</div>
			}
			footer={[
				<AntdButton key="cancel" onClick={onClose}>
					取消
				</AntdButton>,
				<AntdButton
					key="submit"
					type="primary"
					loading={busy}
					icon={<IconChevronRight size={17} />}
					onClick={() => form.submit()}
				>
					创建并进入建档
				</AntdButton>,
			]}
		>
			<Form<CreateProjectValues>
				form={form}
				layout="vertical"
				className="create-project-form"
				onFinish={submit}
				initialValues={{ language: "zh-CN" }}
				requiredMark="optional"
			>
				<Form.Item name="name" label="客户名称" rules={[{ required: true, message: "请输入客户名称" }]}>
					<Input placeholder="企业或品牌全称" />
				</Form.Item>
				<Form.Item
					name="websiteUrl"
					label="官网"
					rules={[
						{ required: true, message: "请输入官网地址" },
						{ type: "url", message: "请输入有效网址" },
					]}
				>
					<Input placeholder="https://example.com" />
				</Form.Item>
				<Form.Item name="region" label="目标地区" rules={[{ required: true, message: "请输入目标地区" }]}>
					<Input placeholder="例如：中国 / 上海" />
				</Form.Item>
				<Form.Item name="language" label="语言" rules={[{ required: true, message: "请输入语言" }]}>
					<Input />
				</Form.Item>
				<Form.Item
					className="form-item-wide"
					name="industry"
					label="所属行业"
					rules={[{ required: true, message: "请输入所属行业" }]}
				>
					<Input placeholder="用于复用机构内同业问题库" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="businessFocus" label="业务重点（可选）">
					<Input.TextArea rows={3} placeholder="本阶段希望重点推广的产品或服务" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="aliases" label="品牌别名（可选）">
					<Input placeholder="用逗号分隔" />
				</Form.Item>
				<Form.Item className="form-item-wide" name="knownCompetitors" label="已知竞品（可选）">
					<Input placeholder="名称或官网，用逗号分隔" />
				</Form.Item>
			</Form>
		</Modal>
	);
}
