import { migrateDatabase, openMemoryDatabase } from "@geo/core";
import { ADAPTER_VERSION } from "@geo/search-providers";
import { describe, expect, it } from "vitest";
import { assertCurrentCaptureContract, captureContractCurrent } from "./capture-contract";
import { reparseMeasurement, runOneSemanticJob } from "./measurement";
import { advanceReportWorkflow } from "./report-snapshots";
import { getBatch } from "./service";
import { seedMetricSnapshot } from "./test-support/measurement";

describe("capture extraction version boundary", () => {
	it("a suspended organization cannot claim more paid semantic work", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query(
				"INSERT INTO projects(id,name,website_url,domain,region,language,status) VALUES('p','暂停验收','https://example.com','example.com','CN','zh-CN','active')",
			);
			await db.query(
				"INSERT INTO experiment_batches(id,project_id,kind,status,config,config_hash) VALUES('b','p','quick_audit','complete','{}','test')",
			);
			await db.query(
				"INSERT INTO semantic_parse_runs(id,organization_id,project_id,batch_id,contract,contract_hash) VALUES('r','default','p','b','{}','test')",
			);
			await db.query(
				`INSERT INTO jobs(id,type,payload,status) VALUES('j','semantic_parse','{"runId":"r","captureId":"not-claimed"}','pending')`,
			);
			await db.query("UPDATE organizations SET suspended_at=now() WHERE id='default'");
			expect(await runOneSemanticJob(db, "test-worker")).toBe(false);
			expect((await db.query("SELECT status FROM jobs WHERE id='j'")).rows[0].status).toBe("pending");
		} finally {
			await db.close();
		}
	});
	it("only the current complete provider contract is reusable", () => {
		expect(
			captureContractCurrent({
				providers: [{ adapterVersion: ADAPTER_VERSION, endpoint: "https://provider.example" }],
			}),
		).toBe(true);
		for (const input of [
			{},
			{ providers: [] },
			{ providers: [{ adapterVersion: "cloud-search.v1", endpoint: "https://provider.example" }] },
		])
			expect(() => assertCurrentCaptureContract(input)).toThrow("旧批次");
	});
	it("old derived metrics stay archived but cannot be reparsed or published as current results", async () => {
		const db = openMemoryDatabase();
		try {
			await migrateDatabase(db);
			await db.query(
				"INSERT INTO projects(id,name,website_url,domain,region,language,status) VALUES('p','协议验收','https://example.com','example.com','CN','zh-CN','active')",
			);
			await db.query(
				`INSERT INTO experiment_batches(id,project_id,kind,status,config,config_hash) VALUES('b','p','quick_audit','complete','{"providers":[{"id":"qwen_api","endpoint":"https://provider.example","adapterVersion":"cloud-search.v1"}]}','old')`,
			);
			const snapshot = await seedMetricSnapshot(db, "b");
			const batch = await getBatch(db, "b");
			expect(batch?.measurement).toMatchObject({
				status: "capture_contract_changed",
				snapshotId: null,
				captureContractCurrent: false,
			});
			await expect(reparseMeasurement(db, "b", null)).rejects.toMatchObject({ status: 409 });
			await expect(advanceReportWorkflow(db, "b", { actor: { kind: "local" } })).rejects.toMatchObject({ status: 409 });
			expect((await db.query("SELECT id FROM metric_snapshots WHERE id=$1", [snapshot])).rows).toHaveLength(1);
		} finally {
			await db.close();
		}
	});
});
