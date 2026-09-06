import { HttpInputError } from "./utils";

/** Missing optional groups stay falsey; decodeURIComponent(undefined) would turn them into the truthy string "undefined". */
export function routeMatch(pathname: string, expression: RegExp): string[] | null {
	const match = pathname.match(expression);
	if (!match) return null;
	try {
		return match.slice(1).map((value) => (value === undefined ? "" : decodeURIComponent(value)));
	} catch {
		throw new HttpInputError("路由参数编码无效", 400);
	}
}
