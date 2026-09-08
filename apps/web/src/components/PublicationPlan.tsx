import type { PublicationPlan } from "@geo/evidence";
import { Alert, Button, Form, Input, Select, Tag } from "antd";
import { EvidenceRef } from "../ui/primitives";

export function PublicationPlanView({ plan }: { plan: Partial<PublicationPlan> | null }) {
	if (!plan) return <Alert type="warning" showIcon title="历史文章没有保存用途与发布计划，请补充后再发布。" />;
	return (
		<section>
			<h3>用途与发布计划</h3>
			<p>
				<b>用途：</b>
				{plan.purpose || "尚未填写"}
			</p>
			<p>
				<b>解决的问题：</b>
				{plan.problem || "尚未填写"}
			</p>
			<p>
				<b>给谁看：</b>
				{plan.audience || "尚未填写"}
			</p>
			<h4>写作安排</h4>
			{plan.contentStrategy ? (
				<>
					<p>
						<b>内容形式：</b>
						{plan.contentStrategy.format || "尚未填写"}
					</p>
					<p>
						<b>选择理由：</b>
						{plan.contentStrategy.rationale || "尚未填写"}
					</p>
					<p>
						<b>篇幅安排：</b>
						{plan.contentStrategy.lengthApproach || "尚未填写"}
					</p>
				</>
			) : (
				<p>尚未填写内容形式与篇幅安排。</p>
			)}
			<h4>建议发布位置</h4>
			{!plan.channels?.length && <Alert type="warning" title="尚未填写建议发布位置，请补全后再发布。" />}
			{(plan.channels ?? []).map((c) => (
				<article key={`${c.platform}:${c.placement}`}>
					<p>
						<Tag>
							{c.basis === "candidate"
								? "候选渠道，待核验"
								: c.basis === "observed_source"
									? "证据中出现的渠道"
									: "客户自有渠道"}
						</Tag>
						<b>{c.platform}</b> · {c.placement}
					</p>
					<p>选择理由：{c.reason}</p>
					<p>内容调整：{c.adaptation}</p>
					<p>发布前确认：{c.prerequisite}</p>
					<EvidenceRef ids={c.evidenceIds ?? []} index={[]} />
				</article>
			))}
			<h4>验收步骤</h4>
			<ol>
				{(plan.acceptance ?? []).map((s) => (
					<li key={s}>{s}</li>
				))}
			</ol>
			<p>发布需自行完成；AI 是否引用以复测结果为准。</p>
		</section>
	);
}

export function PublicationPlanFields() {
	return (
		<section>
			<h3>用途与发布计划</h3>
			{[
				["purpose", "文章用途"],
				["problem", "要解决的问题"],
				["audience", "目标读者"],
			].map(([name, label]) => (
				<Form.Item
					key={name}
					name={["publicationPlan", name]}
					label={label}
					rules={[{ required: true, message: `请填写${label}` }]}
				>
					<Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
				</Form.Item>
			))}
			{[
				["format", "内容形式"],
				["rationale", "选择理由"],
				["lengthApproach", "篇幅安排"],
			].map(([name, label]) => (
				<Form.Item
					key={name}
					name={["publicationPlan", "contentStrategy", name]}
					label={label}
					rules={[{ required: true, whitespace: true, message: `请填写${label}` }]}
				>
					<Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
				</Form.Item>
			))}
			<Form.List name={["publicationPlan", "channels"]}>
				{(fields, { add, remove }) => (
					<>
						{fields.map((field) => (
							<section key={field.key}>
								<h4>建议渠道 {field.name + 1}</h4>
								{[
									["platform", "发布平台"],
									["placement", "栏目或页面"],
									["reason", "选择理由"],
									["adaptation", "内容调整"],
									["prerequisite", "发布前需确认"],
								].map(([key, label]) => (
									<Form.Item key={key} name={[field.name, key]} label={label} rules={[{ required: true }]}>
										<Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
									</Form.Item>
								))}
								<Form.Item name={[field.name, "basis"]} label="推荐依据" rules={[{ required: true }]}>
									<Select
										options={[
											{ value: "candidate", label: "候选渠道，尚待核验" },
											{ value: "owned", label: "已确认的客户自有渠道" },
											{ value: "observed_source", label: "本篇绑定证据中出现的渠道" },
										]}
									/>
								</Form.Item>
								<Button onClick={() => remove(field.name)}>删除此渠道</Button>
							</section>
						))}
						{fields.length < 6 && (
							<Button onClick={() => add({ basis: "candidate", evidenceIds: [] })}>添加建议发布渠道</Button>
						)}
					</>
				)}
			</Form.List>
			<Form.List name={["publicationPlan", "acceptance"]}>
				{(fields, { add, remove }) => (
					<>
						<h4>验收步骤</h4>
						{fields.map((field) => (
							<Form.Item key={field.key} label={`步骤 ${field.name + 1}`}>
								<Form.Item name={field.name} noStyle rules={[{ required: true }]}>
									<Input.TextArea autoSize />
								</Form.Item>
								<Button type="link" onClick={() => remove(field.name)}>
									删除步骤
								</Button>
							</Form.Item>
						))}
						{fields.length < 10 && <Button onClick={() => add()}>添加验收步骤</Button>}
					</>
				)}
			</Form.List>
		</section>
	);
}
