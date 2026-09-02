import { Breadcrumb, Typography } from "antd";
import type { ReactNode } from "react";
import "./Page.css";

export function Page({
	breadcrumb,
	eyebrow,
	title,
	description,
	extra,
	className,
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
			{children}
		</section>
	);
}
