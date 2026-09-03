import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Button, Input } from "antd";
import type { ReactNode } from "react";
import { Button as AccessButton } from "../access";

export type EditableField<T> = {
	key: keyof T & string;
	label: string;
	placeholder?: string;
	/** 值为 string[]，以逗号分隔文本编辑 */
	commaList?: boolean;
	/** 输入框宽度（px），默认 160 */
	width?: number;
};

export function splitEditableValues(value: string): string[] {
	return value
		.split(/[，,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

type EditableListBase = {
	title: ReactNode;
	description?: ReactNode;
	addLabel?: string;
};

type EditableRowsProps<T> = EditableListBase & {
	items: T[];
	onChange(next: T[]): void;
	fields: EditableField<T>[];
	makeNew(): T;
	addPermission?: string;
	empty?: ReactNode;
	indexed?: boolean;
	/** 行尾附加只读内容（如竞品的联网核实标签） */
	extra?(item: T): ReactNode;
};

type JoinedListProps = EditableListBase & {
	joined: true;
	items: string[];
	onChange(next: string[]): void;
	placeholder?: string;
};

/** 别名/竞品/问题等可编辑列表，Onboarding 与 ScopeEditor 共用 */
export function EditableList<T extends object>(props: EditableRowsProps<T> | JoinedListProps) {
	const { title, description } = props;
	const head = (
		<div className="section-head compact">
			<div>
				<h3>{title}</h3>
				{description ? <p className="muted">{description}</p> : null}
			</div>
			{"makeNew" in props ? (
				<AccessButton
					permission={props.addPermission}
					variant="secondary"
					icon={<IconPlus size={16} />}
					onClick={() => props.onChange([...props.items, props.makeNew()])}
				>
					{props.addLabel ?? "添加"}
				</AccessButton>
			) : null}
		</div>
	);
	if ("joined" in props) {
		return (
			<div className="review-section">
				{head}
				<Input
					value={props.items.join("，")}
					placeholder={props.placeholder}
					onChange={(event) => props.onChange(splitEditableValues(event.target.value))}
				/>
			</div>
		);
	}
	return (
		<div className="review-section">
			{head}
			{props.items.length === 0 ? (
				(props.empty ?? <p className="muted">当前没有条目，可以添加后再确认。</p>)
			) : (
				<div className="editable-list">
					{props.items.map((item, index) => (
						<div className="editable-row" key={(item as { id?: string }).id ?? index}>
							{props.indexed ? <span className="row-index">{index + 1}</span> : null}
							{props.fields.map((field) => (
								<Input
									key={field.key}
									aria-label={field.label}
									placeholder={field.placeholder ?? field.label}
									style={{ width: field.width ?? 160 }}
									value={
										field.commaList
											? ((item[field.key] as unknown as string[] | undefined) ?? []).join("，")
											: ((item[field.key] as string | undefined) ?? "")
									}
									onChange={(event) => {
										const value: unknown = field.commaList
											? splitEditableValues(event.target.value)
											: event.target.value;
										props.onChange(
											props.items.map((entry, i) => (i === index ? { ...entry, [field.key]: value } : entry)),
										);
									}}
								/>
							))}
							{props.extra?.(item)}
							<Button
								type="text"
								aria-label={`删除${typeof title === "string" ? `该${title}` : "该条"}`}
								icon={<IconTrash size={16} />}
								onClick={() => props.onChange(props.items.filter((_, i) => i !== index))}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
