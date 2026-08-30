import type { FrozenBatchConfig } from "./schema";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function areBatchConfigsComparable(left: FrozenBatchConfig, right: FrozenBatchConfig): boolean {
	return canonical(left) === canonical(right);
}
