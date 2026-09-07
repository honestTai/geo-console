import { access } from "node:fs/promises";
import { load } from "cheerio";
import { chromium } from "playwright";
import { fetchPublicResource } from "./public-http";

/** Fresh browser, no profile or credentials. Callers must deny or intercept every network request. */
export async function launchEvidenceBrowser() {
	let executablePath = process.env.GEO_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
	if (!executablePath) {
		try {
			await access(chromium.executablePath());
		} catch {
			if (process.platform === "darwin")
				executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		}
	}
	return chromium.launch({
		headless: true,
		executablePath,
		timeout: 15_000,
		args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
	});
}

export function staticEvidenceHtml(html: string, url: string, renderScripts = false): string {
	const $ = load(html);
	// A CMS may set a relative asset base; replacing it with the document URL loses all CSS/images.
	let base = url;
	try {
		const declared = new URL($("base[href]").first().attr("href") ?? url, url);
		if (["https:", "http:"].includes(declared.protocol)) base = declared.href;
	} catch {
		/* Invalid bases fall back to the final document URL. */
	}
	$("iframe,frame,object,embed,base,meta[http-equiv],link[rel='preload'],link[rel='prefetch']").remove();
	if (!renderScripts) $("script").remove();
	$("head").prepend(`<base href="${base.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`);
	$("head").prepend(
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data:; font-src http: https: data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:">`,
	);
	$("body").prepend(
		`<div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#fff;color:#333;padding:10px;border-top:1px solid #bbb;font:12px sans-serif">ZZGEO 审计取证 · 已保存 HTML 的${renderScripts ? "受控浏览器截图（允许展示脚本；禁用 API、表单、嵌入页面和实时连接）" : "静态浏览器截图（脚本禁用；未执行表单或交互）"}</div>`,
	);
	return $.html();
}

function assetQueue() {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (work: () => Promise<void>) => {
		if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
		else active++;
		try {
			await work();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

export async function websiteScreenshot(
	html: string,
	url: string,
	onDiagnostics?: (value: { loaded: number; failed: number; blocked: number }) => void,
): Promise<Buffer> {
	const browser = await launchEvidenceBrowser();
	const timer = setTimeout(() => void browser.close().catch(() => undefined), 40_000);
	timer.unref();
	try {
		const context = await browser.newContext({
			javaScriptEnabled: true,
			serviceWorkers: "block",
			acceptDownloads: false,
			// Fail closed if any browser request escapes routing; only Node's validated GET fetcher has egress.
			proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
			viewport: { width: 1440, height: 1000 },
		});
		await context.routeWebSocket("**/*", (socket) => socket.close());
		await context.addInitScript(() => {
			Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
			Object.defineProperty(window, "webkitRTCPeerConnection", { value: undefined });
		});
		const page = await context.newPage();
		page.on("dialog", (dialog) => void dialog.dismiss());
		page.on("popup", (popup) => void popup.close());
		page.setDefaultTimeout(15_000);
		const deadline = Date.now() + 20_000;
		let resources = 0,
			bytes = 0;
		const stats = { loaded: 0, failed: 0, blocked: 0 };
		const queue = assetQueue();
		await context.route("**/*", (route) =>
			queue(async () => {
				try {
					if (
						!["image", "stylesheet", "font", "script"].includes(route.request().resourceType()) ||
						route.request().method() !== "GET" ||
						++resources > 200 ||
						bytes > 24 * 1024 * 1024 ||
						Date.now() > deadline
					) {
						stats.blocked++;
						return await route.abort();
					}
					const data = await fetchPublicResource(
						new URL(route.request().url()),
						Math.max(500, Math.min(5000, deadline - Date.now())),
						"GEOConsole/0.1 (+audit screenshot)",
					);
					bytes += data.body.length;
					if (
						!/^(image\/(?!svg)|image\/svg\+xml|text\/(?:css|javascript)|font\/|application\/(?:javascript|x-javascript|ecmascript|font|x-font|vnd.ms-fontobject|octet-stream))/i.test(
							data.contentType,
						) ||
						bytes > 24 * 1024 * 1024
					) {
						stats.blocked++;
						return await route.abort();
					}
					await route.fulfill({ status: 200, contentType: data.contentType, body: data.body });
					stats.loaded++;
				} catch {
					stats.failed++;
					await route.abort().catch(() => undefined);
				}
			}),
		);
		await page.setContent(staticEvidenceHtml(html, url, true), { waitUntil: "domcontentloaded", timeout: 15_000 });
		await page.waitForLoadState("load", { timeout: 8000 }).catch(() => undefined);
		await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
		const image = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", timeout: 10_000 });
		onDiagnostics?.(stats);
		return image;
	} finally {
		clearTimeout(timer);
		await browser.close();
	}
}
