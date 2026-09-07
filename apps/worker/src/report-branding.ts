export const escapeReportHtml = (value: unknown): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

/** Same Z mark and brand wordmark as the console; embedded assets work in offline PDF/HTML. */
export const reportLogo = '<span class="zz-logo"><span class="zz-mark">Z</span><strong>ZZGEO</strong></span>';
export const reportBrandStyles = `.zz-logo{display:inline-flex;align-items:center;gap:9px;font:700 20px sans-serif;letter-spacing:1px;color:#17241f}.zz-mark{display:inline-grid;place-items:center;width:33px;height:33px;border-radius:8px;background:#13a65a;color:#fff;font:800 24px sans-serif}.zz-watermark{position:fixed;top:40%;left:8%;width:84%;text-align:center;transform:rotate(-24deg);color:rgba(26,79,49,.045);font:bold 90px sans-serif;pointer-events:none;z-index:0;overflow-wrap:anywhere}.zz-watermark small{display:block;font-size:20px;margin-top:12px}.zz-content{position:relative;z-index:1}.zz-customer{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:15px;background:#f7f9f8;border:1px solid #dce2de;margin:20px 0;font-size:13px;overflow-wrap:anywhere}.zz-audit-check{border:1px solid #dce2de;padding:14px;margin:14px 0;break-inside:avoid;overflow-wrap:anywhere}.zz-audit-check h3{margin:0 0 8px}.zz-audit-check p{margin:6px 0}.zz-evidence{max-width:100%;max-height:700px;object-fit:contain;border:1px solid #dce2de}.zz-evidence-table{table-layout:fixed;width:100%;overflow-wrap:anywhere}.zz-appendix pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}.zz-appendix{break-inside:auto}@media print{.zz-content{padding:0!important}thead{display:table-header-group}tr{break-inside:avoid}section.section{break-inside:auto}.zz-watermark{font-size:72px}}@media(max-width:600px){.zz-customer{grid-template-columns:1fr}.zz-watermark{font-size:48px}}`;

export function reportWatermark(customer: string) {
	return `<div aria-hidden="true" class="zz-watermark">ZZGEO<small>${escapeReportHtml(customer)}</small></div>`;
}
export function customerBlock(
	customer: {
		name?: unknown;
		domain?: unknown;
		websiteUrl?: unknown;
		region?: unknown;
		language?: unknown;
		industry?: unknown;
	},
	checkedAt?: string,
) {
	return `<div class="zz-customer"><div>客户：${escapeReportHtml(customer.name)}</div><div>官网：${escapeReportHtml(customer.websiteUrl || customer.domain || "未提供（不适用）")}</div><div>地区：${escapeReportHtml(customer.region || "未提供")}</div><div>行业：${escapeReportHtml(customer.industry || "未提供")}</div><div>语言：${escapeReportHtml(customer.language || "未提供")}</div><div>证据时间：${escapeReportHtml(checkedAt || "见采样记录")}</div></div>`;
}
