import {
	type CaptureAdapter,
	CaptureAdapterError,
	classifySessionText,
	currentCollectorVersion,
	type ExtractedAnswer,
	type SessionState,
} from "@geo/surface-adapters";
import type { BrowserContext, Locator, Page } from "playwright";

type AdapterOptions = {
	id: "deepseek" | "kimi";
	displayName: string;
	consumerUrl: string;
	composerSelectors: string[];
	answerSelectors: string[];
	newConversationSelectors: string[];
	busySelectors?: string[];
	sourceContainerSelectors?: string[];
	queryFanOutSelectors?: string[];
};

const challengePattern = /验证码|安全验证|访问过于频繁|verify you are human|captcha/i;
const rateLimitPattern = /请求过于频繁|稍后再试|rate limit|too many requests/i;

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
	for (const selector of selectors) {
		const locator = page.locator(selector).last();
		if ((await locator.count()) && (await locator.isVisible().catch(() => false))) return locator;
	}
	return null;
}

class ConsumerSurfaceAdapter implements CaptureAdapter {
	readonly version = currentCollectorVersion;
	readonly id: "deepseek" | "kimi";
	readonly displayName: string;
	readonly consumerUrl: string;
	private readonly composerSelectors: string[];
	private readonly answerSelectors: string[];
	private readonly newConversationSelectors: string[];
	private readonly busySelectors: string[];
	private readonly sourceContainerSelectors: string[];
	private readonly queryFanOutSelectors: string[];

	constructor(options: AdapterOptions) {
		this.id = options.id;
		this.displayName = options.displayName;
		this.consumerUrl = options.consumerUrl;
		this.composerSelectors = options.composerSelectors;
		this.answerSelectors = options.answerSelectors;
		this.newConversationSelectors = options.newConversationSelectors;
		this.busySelectors = options.busySelectors ?? [];
		this.sourceContainerSelectors = options.sourceContainerSelectors ?? [];
		this.queryFanOutSelectors = options.queryFanOutSelectors ?? [];
	}

	async checkSession(page: Page): Promise<SessionState> {
		await page.goto(this.consumerUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
		await page.waitForTimeout(1500);
		const body = await page
			.locator("body")
			.innerText()
			.catch(() => "");
		return classifySessionText(body, Boolean(await firstVisible(page, this.composerSelectors)));
	}

	async openLogin(context: BrowserContext): Promise<void> {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(this.consumerUrl, { waitUntil: "domcontentloaded" });
		await page.bringToFront();
	}

	async startConversation(page: Page): Promise<void> {
		await page.goto(this.consumerUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
		await page.waitForTimeout(1000);
		const button = await firstVisible(page, this.newConversationSelectors);
		if (button) await button.click().catch(() => undefined);
	}

	async submitQuestion(page: Page, question: string): Promise<void> {
		const composer = await firstVisible(page, this.composerSelectors);
		if (!composer) throw new CaptureAdapterError("page_contract_changed", `${this.displayName} 输入框未找到`);
		const tag = await composer.evaluate((element) => element.tagName.toLowerCase());
		if (tag === "textarea" || tag === "input") await composer.fill(question);
		else {
			await composer.click();
			await page.keyboard.insertText(question);
		}
		await composer.press("Enter");
	}

	async waitForAnswer(page: Page, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let previous = "";
		let stableCount = 0;
		while (Date.now() < deadline) {
			const body = await page
				.locator("body")
				.innerText()
				.catch(() => "");
			if (challengePattern.test(body))
				throw new CaptureAdapterError("verification_required", `${this.displayName} 要求安全验证`);
			if (rateLimitPattern.test(body))
				throw new CaptureAdapterError("rate_limited", `${this.displayName} 返回限流提示`);
			if (await firstVisible(page, this.busySelectors)) {
				previous = "";
				stableCount = 0;
				await page.waitForTimeout(1500);
				continue;
			}
			const answers = await this.answerTexts(page);
			const current = answers.at(-1)?.trim() ?? "";
			if (current.length >= 20 && current === previous) stableCount += 1;
			else stableCount = 0;
			if (stableCount >= 3) return;
			previous = current;
			await page.waitForTimeout(1500);
		}
		throw new CaptureAdapterError("answer_timeout", `${this.displayName} 回答等待超时`);
	}

	private async answerTexts(page: Page): Promise<string[]> {
		for (const selector of this.answerSelectors) {
			const texts = (
				await page
					.locator(selector)
					.allInnerTexts()
					.catch(() => [])
			)
				.map((value) => value.trim())
				.filter((value) => value.length >= 20);
			if (texts.length) return texts;
		}
		return [];
	}

	async extractAnswer(page: Page): Promise<ExtractedAnswer> {
		let container: Locator | null = null;
		for (const selector of this.answerSelectors) {
			const candidates = page.locator(selector);
			if (await candidates.count()) {
				container = candidates.last();
				break;
			}
		}
		if (!container) throw new CaptureAdapterError("page_contract_changed", `${this.displayName} 回答容器未找到`);
		const answerText = (await container.innerText()).trim();
		if (!answerText) throw new CaptureAdapterError("no_answer", `${this.displayName} 回答正文为空`);
		const sourceContainer = (await firstVisible(page, this.sourceContainerSelectors)) ?? container;
		const links = await sourceContainer.locator("a[href]").evaluateAll((anchors) =>
			anchors.map((anchor) => ({
				url: (anchor as HTMLAnchorElement).href,
				title: (anchor.textContent ?? "").trim(),
			})),
		);
		const seenUrls = new Set<string>();
		const sources = links.flatMap((link) => {
			try {
				const url = new URL(link.url);
				if (!["http:", "https:"].includes(url.protocol)) return [];
				if (seenUrls.has(url.href)) return [];
				seenUrls.add(url.href);
				return [
					{
						url: url.href,
						domain: url.hostname.replace(/^www\./, ""),
						title: link.title || null,
						position: seenUrls.size,
						isCitation: true,
					},
				];
			} catch {
				return [];
			}
		});
		const queryFanOut = await this.extractQueryFanOut(page, answerText);
		return { answerText, sources, queryFanOut, pageUrl: page.url() };
	}

	private async extractQueryFanOut(page: Page, answerText: string): Promise<string[]> {
		const values = new Set<string>();
		for (const selector of this.queryFanOutSelectors) {
			const texts = await page
				.locator(selector)
				.allInnerTexts()
				.catch(() => []);
			for (const raw of texts)
				for (const line of raw.split(/\n+/)) {
					const value = line
						.replace(/^[\s\d.、-]+/, "")
						.replace(/\s+/g, " ")
						.trim();
					if (value.length < 2 || value.length > 200 || answerText.includes(value)) continue;
					values.add(value);
				}
		}
		return [...values].slice(0, 50);
	}
}

export const adapters = {
	deepseek: new ConsumerSurfaceAdapter({
		id: "deepseek",
		displayName: "DeepSeek",
		consumerUrl: "https://chat.deepseek.com/",
		composerSelectors: ["textarea[placeholder*='DeepSeek']", "textarea", "[contenteditable='true'][role='textbox']"],
		answerSelectors: [".ds-markdown", "[class*='markdown']", "main [class*='message']"],
		newConversationSelectors: ["button:has-text('新对话')", "button:has-text('开启新对话')", "[aria-label*='新对话']"],
		queryFanOutSelectors: ["[class*='search-query']", "[class*='search'] [class*='query']"],
	}),
	kimi: new ConsumerSurfaceAdapter({
		id: "kimi",
		displayName: "Kimi",
		consumerUrl: "https://www.kimi.com/",
		composerSelectors: [
			".chat-input-editor[contenteditable='true']",
			"[contenteditable='true'][role='textbox']",
			"textarea",
		],
		answerSelectors: [
			".segment-content-box .markdown-container:not(.toolcall-content-text)",
			"main [class*='message'] .markdown-container:not(.toolcall-content-text)",
		],
		newConversationSelectors: ["button:has-text('新建会话')", "button:has-text('新对话')", "[aria-label*='新建']"],
		busySelectors: [".send-button-container.stop"],
		sourceContainerSelectors: [".segment-content-box"],
		queryFanOutSelectors: [
			".segment-content-box .toolcall-content-text",
			".segment-content-box [class*='search-query']",
		],
	}),
} as const;
