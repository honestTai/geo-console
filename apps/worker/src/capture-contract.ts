import type { Database } from "@geo/core";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { HttpInputError, parseJsonColumn } from "./utils";

export function captureContractCurrent(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const providers = (value as { providers?: unknown }).providers;
	return (
		Array.isArray(providers) &&
		providers.length > 0 &&
		providers.every(
			(provider) =>
				provider &&
				typeof provider === "object" &&
				provider.adapterVersion === ADAPTER_VERSION &&
				typeof provider.endpoint === "string" &&
				provider.endpoint.length > 0,
		)
	);
}
export function assertCurrentCaptureContract(value: unknown): void {
	if (!captureContractCurrent(value))
		throw new HttpInputError("采集正文与引用解析协议已更新；旧批次仅保留审计，请新建批次后再解析、诊断或生成报告", 409);
}
export async function assertBatchCaptureContract(database: Database, batchId: string): Promise<void> {
	const row = (
		await database.query<{ config: unknown }>("SELECT config FROM experiment_batches WHERE id=$1", [batchId])
	).rows[0];
	if (!row) throw new HttpInputError("采集批次不存在", 404);
	assertCurrentCaptureContract(parseJsonColumn(row.config));
}
