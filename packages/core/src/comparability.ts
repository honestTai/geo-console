import type { FrozenBatchConfig } from "./schema";

/**
 * 与 JSON.stringify 一样忽略值为 undefined 的键：内存中刚构造的配置（如可选的 secondaryEndpoint 未设置）
 * 与从 jsonb 读回的同一配置必须判定为可比，否则周期监测永远认为“范围变了”。
 */
function canonical(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function areBatchConfigsComparable(left: FrozenBatchConfig, right: FrozenBatchConfig): boolean {
	return canonical(left) === canonical(right);
}
