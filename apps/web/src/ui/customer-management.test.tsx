import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext } from "../access";
import { CustomerManagement } from "../components/CustomerManagement";
import { managementViews, type UserIdentity } from "../types";
import { views } from "./workspace-views";

const state = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../hooks/usePagination", () => ({
	usePaginated: () => ({
		items: state.error
			? []
			: [
					{
						id: "test-only",
						name: "测试客户",
						website_url: null,
						region: "测试地区",
						industry: "测试行业",
						business_focus: "测试资料",
						status: "draft",
						batch_count: 0,
						last_batch_at: null,
					},
				],
		page: 1,
		pageSize: 20,
		total: 1,
		totalPages: 1,
		loading: false,
		error: state.error,
		setPage: vi.fn(),
		setPageSize: vi.fn(),
		reload: vi.fn(),
	}),
}));
const render = (permissions: string[], canOpenWorkspace = false) =>
	renderToStaticMarkup(
		<AccessContext.Provider value={{ permissions, isSuperAdmin: false } as UserIdentity}>
			<CustomerManagement
				organizationName="测试机构"
				canOpenWorkspace={canOpenWorkspace}
				onOpenProject={() => {}}
				onCreated={async () => {}}
				onChanged={async () => {}}
			/>
		</AccessContext.Provider>,
	);
beforeEach(() => {
	state.error = null;
});
describe("customer management UI", () => {
	it("registers as an organization view and keeps read-only members from seeing write actions", () => {
		expect(managementViews).toContain("customers");
		expect(views.find((view) => view.id === "customers")?.label).toBe("客户管理");
		const html = render(["page.customers"]);
		expect(html).toContain("测试客户");
		expect(html).toContain("未填写");
		for (const text of ["新建客户", "编辑客户信息", "进入工作台"]) expect(html).not.toContain(text);
	});
	it("reuses separately authorized create/edit actions and permits workspace navigation only when available", () => {
		const html = render(["page.customers", "project.create", "project.onboard"], true);
		for (const text of ["新建客户", "编辑客户信息", "进入工作台", "待建档"]) expect(html).toContain(text);
	});
	it("shows a recoverable list error instead of silently pretending there are no customers", () => {
		state.error = new Error("客户读取失败");
		const html = render(["page.customers"]);
		expect(html).toContain("客户读取失败");
		expect(html).toContain("重试列表");
	});
});
