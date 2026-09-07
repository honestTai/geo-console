import { load } from "cheerio";

export type WebsiteProbe = {
	ok: boolean;
	status: number | null;
	url: string | null;
	body: string;
	contentType: string;
	error: string | null;
};
export type SitemapProbe = WebsiteProbe & {
	requestedUrl: string;
	kind: "urlset" | "index" | "html" | "invalid" | "unavailable";
	urlCount: number;
};

const publicProtocol = (url: URL) => ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
function candidate(value: string, base: URL): string | null {
	try {
		const url = new URL(value.trim(), base);
		url.hash = "";
		return publicProtocol(url) ? url.href : null;
	} catch {
		return null;
	}
}

/** Parse document type, not merely <loc> occurrences. An index is not a set of page URLs. */
export function parseSitemap(
	body: string,
	base: URL,
): { kind: "urlset" | "index" | "html" | "invalid"; urls: string[] } {
	const $ = load(body, { xmlMode: true });
	const root = $.root().children().first();
	const name = root.get(0)?.tagName?.split(":").at(-1)?.toLowerCase();
	if (name !== "urlset" && name !== "sitemapindex")
		return { kind: /<html(?:\s|>)/i.test(body) ? "html" : "invalid", urls: [] };
	const entry = name === "urlset" ? "url" : "sitemap";
	const urls = root
		.children()
		.toArray()
		.filter((el) => el.tagName?.split(":").at(-1) === entry)
		.flatMap((el) => {
			const loc = $(el)
				.children()
				.toArray()
				.find((child) => child.tagName?.split(":").at(-1) === "loc");
			const value = loc ? candidate($(loc).text(), base) : null;
			return value ? [value] : [];
		});
	return { kind: name === "urlset" ? "urlset" : "index", urls: [...new Set(urls)].slice(0, 5000) };
}

function sitemapSeeds(root: URL, robots: string, html: string) {
	const $ = load(html);
	const declared = robots.split(/\r?\n/).flatMap((line) => {
		const value = line.replace(/#.*$/, "").match(/^\s*sitemap\s*:\s*(.+)$/i)?.[1];
		return value ? [value.trim()] : [];
	});
	const htmlMaps = new Set<string>();
	$("link[rel~='sitemap'],a[href]").each((_i, el) => {
		const href = $(el).attr("href");
		if (!href) return;
		if (
			$(el).attr("rel")?.split(/\s+/).includes("sitemap") ||
			/sitemap|网站地图|站点地图/i.test(`${href} ${$(el).text()}`)
		) {
			const url = candidate(href, root);
			if (url) {
				declared.push(url);
				htmlMaps.add(url);
			}
		}
	});
	const queue = [...declared, "/sitemap.xml", "/sitemap_index.xml"].flatMap((value) => {
		const url = candidate(value, root);
		return url ? [{ url, depth: 0 }] : [];
	});
	return {
		queue,
		htmlMaps,
		navigationLinkCount: $(
			"nav a[href],header a[href],[role='navigation'] a[href],.nav a[href],.navbar a[href],.menu a[href]",
		).length,
	};
}

async function readSitemapDocument(url: string, read: (url: URL) => Promise<WebsiteProbe>) {
	const probe = await read(new URL(url));
	const parsed = probe.ok
		? parseSitemap(probe.body, new URL(probe.url ?? url))
		: { kind: "unavailable" as const, urls: [] };
	return {
		document: {
			...probe,
			requestedUrl: url,
			kind: parsed.kind,
			urlCount: parsed.kind === "urlset" ? parsed.urls.length : 0,
		},
		urls: parsed.urls,
	};
}

function enqueueSitemapTargets(
	kind: SitemapProbe["kind"],
	found: string[],
	depth: number,
	queue: Array<{ url: string; depth: number }>,
	visited: Set<string>,
	urls: Set<string>,
): boolean {
	if (kind === "urlset") {
		for (const url of found) urls.add(url);
		return found.length >= 5000;
	}
	if (kind !== "index") return false;
	if (depth < 2) for (const url of found.slice(0, 30)) queue.push({ url, depth: depth + 1 });
	return found.length > 30 || (depth >= 2 && found.some((url) => !visited.has(url)));
}

export async function discoverSitemaps(
	root: URL,
	robots: string,
	html: string,
	read: (url: URL) => Promise<WebsiteProbe>,
) {
	const { queue, htmlMaps, navigationLinkCount } = sitemapSeeds(root, robots, html);
	const visited = new Set<string>(),
		urls = new Set<string>();
	const documents: SitemapProbe[] = [];
	let truncated = false;
	const deadline = Date.now() + 45_000;
	while (queue.length && visited.size < 8 && Date.now() < deadline) {
		const current = queue.shift();
		if (!current || visited.has(current.url)) continue;
		visited.add(current.url);
		const { document, urls: found } = await readSitemapDocument(current.url, read);
		documents.push(document);
		truncated = enqueueSitemapTargets(document.kind, found, current.depth, queue, visited, urls) || truncated;
		if (document.kind === "html" && !htmlMaps.has(current.url))
			documents.at(-1)!.error = "该地址返回 HTML 页面，不是 XML Sitemap（可能为重定向或通用错误页）";
	}
	return {
		documents,
		urls: [...urls],
		limited: truncated || queue.some((item) => !visited.has(item.url)) || urls.size >= 5000,
		htmlSitemapUrls: documents
			.filter((doc) => doc.kind === "html" && htmlMaps.has(doc.requestedUrl))
			.map((doc) => doc.requestedUrl),
		navigationLinkCount,
	};
}
