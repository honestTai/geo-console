import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function argument(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = argument("version");
const target = argument("target");
const urlValue = argument("url");
const signatureFile = argument("signature-file");
const output = resolve(argument("output") ?? "dist/desktop/latest.json");
const notes = argument("notes") ?? "ZZ Geo desktop update";

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
	throw new Error("--version 必须是有效 SemVer");
if (!target || !/^(darwin|windows|linux)-(aarch64|x86_64|i686|armv7)$/.test(target))
	throw new Error("--target 必须是 Tauri 支持的 OS-ARCH");
if (!urlValue || new URL(urlValue).protocol !== "https:") throw new Error("--url 必须使用 HTTPS");
if (!signatureFile) throw new Error("缺少 --signature-file");

const signature = (await readFile(resolve(signatureFile), "utf8")).trim();
if (!signature) throw new Error("签名文件为空");

await mkdir(dirname(output), { recursive: true });
await writeFile(
	output,
	`${JSON.stringify(
		{
			version,
			notes,
			pub_date: new Date().toISOString(),
			platforms: { [target]: { url: urlValue, signature } },
		},
		null,
		2,
	)}\n`,
);
console.log(output);
