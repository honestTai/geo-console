import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function argument(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = argument("version");
const target = argument("target");
const bundle = argument("bundle");
const signatureFile = argument("signature-file");
const baseUrl = argument("base-url") ?? "https://www.honesttai.com/desktop";
const outputDirectory = resolve(argument("output-dir") ?? "dist/desktop");
const notes = argument("notes") ?? "ZZ Geo desktop update";

if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
	throw new Error("--version 必须是有效 SemVer");
if (!target || !/^(darwin|windows|linux)-(aarch64|x86_64|i686|armv7)$/.test(target))
	throw new Error("--target 必须是 Tauri 支持的 OS-ARCH");
if (!bundle || !signatureFile) throw new Error("缺少 --bundle 或 --signature-file");
const releaseBaseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
if (releaseBaseUrl.protocol !== "https:") throw new Error("--base-url 必须使用 HTTPS");

const originalName = basename(bundle);
const suffix = originalName.endsWith(".app.tar.gz")
	? ".app.tar.gz"
	: originalName.endsWith(".AppImage")
		? ".AppImage"
		: originalName.endsWith(".exe")
			? ".exe"
			: originalName.endsWith(".msi")
				? ".msi"
				: "";
if (!suffix) throw new Error("无法识别 Tauri updater bundle 类型");

const signature = (await readFile(resolve(signatureFile), "utf8")).trim();
if (!signature) throw new Error("签名文件为空");
const assetName = `zz-geo-${version}-${target}${suffix}`;
await mkdir(outputDirectory, { recursive: true });
await copyFile(resolve(bundle), resolve(outputDirectory, assetName));
await copyFile(resolve(signatureFile), resolve(outputDirectory, `${assetName}.sig`));
await writeFile(
	resolve(outputDirectory, "latest.json"),
	`${JSON.stringify(
		{
			version,
			notes,
			pub_date: new Date().toISOString(),
			platforms: { [target]: { url: new URL(assetName, releaseBaseUrl).href, signature } },
		},
		null,
		2,
	)}\n`,
);
console.log(resolve(outputDirectory, "latest.json"));
