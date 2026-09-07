import { escapeReportHtml as e } from "./report-branding";

export function reportLink(url: unknown, label?: unknown): string {
	try {
		const parsed = new URL(String(url));
		if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
			return e(label ?? "不支持的链接");
		return `<a href="${e(parsed.href)}" target="_blank" rel="noopener noreferrer">${e(label ?? url)}</a>`;
	} catch {
		return e(label ?? url ?? "未提供地址");
	}
}
