import { Breadcrumb, Spin, Typography } from "antd";
import type { ReactNode } from "react";
import "./Page.css";

/** 加载指示延迟：短于这个时间的请求不闪 loading，避免切换视图/批次时的抖动。 */
export const LOADING_DELAY_MS = 300;

export function Page({
	breadcrumb,
	eyebrow,
	title,
	description,
	extra,
	className,
	loading,
	children,
}: {
	/** 面包屑前缀，如当前客户名；与 eyebrow 组成 "客户 / 页面" */
	breadcrumb?: string;
	/** 页面类别小标签，同时作为面包屑末级 */
	eyebrow: string;
	title: string;
	description?: ReactNode;
	/** 右侧主操作区 */
	extra?: ReactNode;
	/** 追加在根 section 上的视图布局类名（保留原视图网格布局） */
	className?: string;
	/** 数据加载中：内容保持挂载并覆盖一层延迟出现的 Spin，而不是先清空再重绘 */
	loading?: boolean;
	children?: ReactNode;
}) {
	const crumbs = [
		...(breadcrumb ? [{ title: breadcrumb }] : []),
		{ title: <span className="page-crumb-current">{eyebrow}</span> },
	];
	return (
		<section className={className ? `page ${className}` : "page"}>
			<header className="page-head">
				<div className="page-head-text">
					<Breadcrumb className="page-breadcrumb" items={crumbs} />
					<Typography.Title level={2} className="page-title">
						{title}
					</Typography.Title>
					{description && (
						<Typography.Paragraph type="secondary" className="page-description">
							{description}
						</Typography.Paragraph>
					)}
				</div>
				{extra && <div className="page-extra">{extra}</div>}
			</header>
			<Spin spinning={Boolean(loading)} delay={LOADING_DELAY_MS} classNames={{ root: "page-loading" }}>
				<div className="page-body">{children}</div>
			</Spin>
		</section>
	);
}
