import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessContext, ProjectReadOnlyContext } from "../access";
import { TaskManagementLayout } from "../components/TaskManagementLayout";
import type { Task, UserIdentity } from "../types";

function render(tasks: Task[] = [], readOnly = false) {
	const identity = { isSuperAdmin: true, permissions: [] } as unknown as UserIdentity;
	return renderToStaticMarkup(
		<AccessContext.Provider value={identity}>
			<ProjectReadOnlyContext.Provider value={readOnly}>
				<TaskManagementLayout
					projectName="测试客户"
					tasks={tasks}
					runs={[]}
					runTotal={0}
					runPage={1}
					runPageSize={20}
					onRunPage={() => {}}
					finishedBatches={[]}
					selectedBatch={null}
					onSelectBatch={() => {}}
					busy={null}
					error={null}
					onCreate={() => {}}
					onPlan={() => {}}
					onRefresh={() => {}}
					renderTask={(task) => <p>{task.title}</p>}
					renderDraft={(run) => <p>{run.id}</p>}
				/>
			</ProjectReadOnlyContext.Provider>
		</AccessContext.Provider>,
	);
}
describe("task-management visual workflow", () => {
	it("keeps unknown worker state distinct from a real zero task count", () => {
		const html = render();
		expect(html).toContain("暂无任务");
		expect(html).toContain("暂无执行记录");
		expect(html).toContain("task-board-stats");
		expect(html).not.toContain("Worker 在线");
		expect(html).not.toContain("垃圾箱");
	});
	it("separates finished tasks and preserves read-only action boundaries", () => {
		const task = (id: string, status: string) =>
			({ id, title: `测试任务${id}`, status, priority: "high", owner: null, due_date: null }) as Task;
		const html = render([task("open", "todo"), task("complete", "verified")], true);
		expect(html).toContain("测试任务open");
		expect(html).not.toContain("测试任务complete");
		expect(html).toContain("已完成任务");
		expect(html).toContain("客户已封档");
		expect(html).not.toContain("创建任务</span>");
	});
});
