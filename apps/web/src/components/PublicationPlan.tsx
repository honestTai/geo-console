import type { PublicationPlan } from "@geo/evidence";
import { Alert, Button, Form, Input, Select, Tag } from "antd";
import { EvidenceRef } from "../ui/primitives";

export function PublicationPlanView({ plan }: { plan: Partial<PublicationPlan> | null }) {
	if (!plan) return <Alert type="warning" showIcon title="历史文章没有保存用途与发布计划，请补充后再发布。" />;
	return (
		<section>
			<h3>这篇文章怎么用？</h3>
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
			<h4>为什么这样写？</h4>
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
				<p>这篇文章尚未记录内容形式与篇幅依据，可补充或重新生成；不会按固定模板自动补齐。</p>
			)}
			<h4>建议发布位置（不是已发布记录）</h4>
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
					<p>为什么：{c.reason}</p>
					<p>怎么调整文章：{c.adaptation}</p>
					<p>发布前确认：{c.prerequisite}</p>
					<EvidenceRef ids={c.evidenceIds ?? []} index={[]} />
				</article>
			))}
			<h4>怎么验收</h4>
			<ol>
				{(plan.acceptance ?? []).map((s) => (
					<li key={s}>{s}</li>
				))}
			</ol>
			<p>填写发布地址只登记人工发布结果，不代表系统替你发布或已被 AI 引用。</p>
		</section>
	);
}

export function PublicationPlanFields() {
	return (
		<section>
			<h3>用途与发布计划</h3>
			<p>
				内容形式、篇幅和结构由实际问题、事实与发布位置决定，不要求固定字数或章节。只填写已核实的客户事实，未核实的平台标为候选。
			</p>
			{[
				["purpose", "文章用来做什么"],
				["problem", "解决哪项问题"],
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
				["format", "本次采用的内容形式"],
				["rationale", "为什么适合这个问题和发布位置"],
				["lengthApproach", "篇幅依据：必须写清什么、哪些不必展开"],
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
									["platform", "具体平台"],
									["placement", "发布栏目或页面位置"],
									["reason", "为什么选择这里"],
									["adaptation", "如何调整文章"],
									["prerequisite", "账号、授权和规则等前置条件"],
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
