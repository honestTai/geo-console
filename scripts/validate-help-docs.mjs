import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helpRoot = resolve(repositoryRoot, "landing/help");
const htmlPath = resolve(helpRoot, "index.html");
const html = await readFile(htmlPath, "utf8");

function matches(pattern) {
	return [...html.matchAll(pattern)].map((match) => match[1]);
}

const sectionIds = new Set(matches(/<section\s+class="help-section"\s+id="([^"]+)"/g));
const directoryTargets = matches(/<a\s+href="#([^"]+)"/g).filter((target) => target !== "manual");
const localAssets = [
	...matches(/<img\s+src="([^"]+)"/g),
	...matches(/<(?:link|script)[^>]+(?:href|src)="([^"]+)"/g),
	"ZZ-Geo-操作手册.pdf",
];

const missingSections = directoryTargets.filter((target) => !sectionIds.has(target));
if (missingSections.length) throw new Error(`Missing help sections: ${missingSections.join(", ")}`);
if (sectionIds.size !== 22) throw new Error(`Expected 22 help sections, found ${sectionIds.size}`);

const screenshotAssets = localAssets.filter((asset) => asset.startsWith("assets/screenshots/"));
if (new Set(screenshotAssets).size !== 25)
	throw new Error(`Expected 25 unique screenshots, found ${new Set(screenshotAssets).size}`);

for (const asset of new Set(localAssets)) {
	if (/^(?:https?:|\/)/.test(asset)) continue;
	await access(resolve(helpRoot, asset.split("?")[0]));
}

for (const forbidden of ["/api/", "/artifacts/", "/share/"]) {
	if (html.includes(forbidden)) throw new Error(`Public help must not reference business route ${forbidden}`);
}

console.log(`Help docs valid: ${sectionIds.size} sections, ${new Set(screenshotAssets).size} screenshots.`);
