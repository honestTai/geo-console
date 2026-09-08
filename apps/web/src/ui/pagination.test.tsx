import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccessContext, Button, ProjectReadOnlyContext, usePermission } from "../access";
import type { UserIdentity } from "../types";
import { Pagination } from "./primitives";

describe("pagination and archived workspace controls", () => {
	it("changes page size without requesting the old page, and ignores the current page", () => {
		const onPage = vi.fn(),
			onPageSize = vi.fn();
		const element = Pagination({ page: 3, pageSize: 10, total: 45, totalPages: 5, onPage, onPageSize });
		element!.props.onChange(2, 20);
		expect(onPageSize).toHaveBeenCalledExactlyOnceWith(20);
		expect(onPage).not.toHaveBeenCalled();
		element!.props.onChange(3, 10);
		expect(onPage).not.toHaveBeenCalled();
		element!.props.onChange(4, 10);
		expect(onPage).toHaveBeenCalledExactlyOnceWith(4);
	});
	it("keeps archived workspaces read-only for superadmins without hiding read controls", () => {
		function Actions() {
			return (
				<>
					{usePermission("articles.manage") && <span>允许编辑</span>}
					<Button permission="audit.run">重新审计</Button>
					<Button variant="secondary">下载资料</Button>
				</>
			);
		}
		const user = { isSuperAdmin: true, permissions: [] } as unknown as UserIdentity;
		const html = renderToStaticMarkup(
			<AccessContext.Provider value={user}>
				<ProjectReadOnlyContext.Provider value>
					<Actions />
				</ProjectReadOnlyContext.Provider>
			</AccessContext.Provider>,
		);
		expect(html).not.toContain("允许编辑");
		expect(html).not.toContain("重新审计");
		expect(html).toContain("下载资料");
	});
});
