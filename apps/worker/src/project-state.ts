import type { Database } from "@geo/core";
import { HttpInputError } from "./utils";

export async function assertProjectAccess(database: Database, projectId: string, write = false): Promise<void> {
	const row = (
		await database.query<{ status: string; deleted_at: string | null }>(
			"SELECT status,deleted_at FROM projects WHERE id=$1",
			[projectId],
		)
	).rows[0];
	if (!row || row.deleted_at) throw new HttpInputError("客户项目不存在", 404);
	if (write && row.status === "archived") throw new HttpInputError("客户已封档，仅可查看历史资料", 409);
}
