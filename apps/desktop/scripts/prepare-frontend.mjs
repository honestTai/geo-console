import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const sourceDirectory = path.resolve(desktopDirectory, "../web/dist");
const targetDirectory = path.resolve(desktopDirectory, "dist");

if (!targetDirectory.startsWith(`${desktopDirectory}${path.sep}`)) {
	throw new Error(`Refusing to replace a directory outside apps/desktop: ${targetDirectory}`);
}

async function javascriptFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await javascriptFiles(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
	}
	return files;
}

await readFile(path.join(sourceDirectory, "index.html"));
await rm(targetDirectory, { recursive: true, force: true });
await mkdir(targetDirectory, { recursive: true });
await cp(sourceDirectory, targetDirectory, { recursive: true });

let originReferences = 0;
for (const file of await javascriptFiles(targetDirectory)) {
	const source = await readFile(file, "utf8");
	const matches = source.match(/window\.location\.origin/g);
	if (!matches) continue;
	originReferences += matches.length;
	await writeFile(file, source.replaceAll("window.location.origin", "window.__GEO_DESKTOP_SERVER_ORIGIN__"));
}

if (originReferences !== 1) {
	throw new Error(`Desktop packaging expected one report share origin in the Web build, found ${originReferences}`);
}

console.log(`Prepared the embedded GEO frontend (${originReferences} desktop origin reference updated).`);
