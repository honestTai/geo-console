import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootFiles = ["README.md", "LICENSE.md", "NOTICE", "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "turbo.json", "biome.json", "compose.yaml", ".env.example", ".gitignore", ".dockerignore"];
const roots = ["apps", "packages", "deploy", "docker", "scripts", "tools", "landing", "docs"];
const excluded = new Set(["node_modules", "dist", "target", "gen", "coverage", "output", "secrets", "server-backups", "__pycache__", "source", "screenshots", "interactive"]);
const privateDocs = new Set(["full-audit-2026-09-06.md", "rbac-demo-verification-2026-09-06.md"]);
export function allowedPath(path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes(":") || isAbsolute(path)) return false;
  if (rootFiles.includes(path)) return true;
  const parts = path.split("/");
  return roots.includes(parts[0]) && parts.every(part => part && !part.startsWith(".") && !excluded.has(part)) && !privateDocs.has(parts.at(-1)) && !/\.(?:map|log|pem|key|pfx|p12|run|dump|tsbuildinfo|pyc)$/i.test(path);
}
async function collect(root, prefix, entries) {
  const target = resolve(root, prefix);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`Symlink refused: ${prefix}`);
  if (info.isDirectory()) {
    for (const entry of (await readdir(target)).sort()) {
      const path = `${prefix}/${entry}`;
      if (allowedPath(path)) await collect(root, path, entries);
    }
  } else if (info.isFile()) entries.push(prefix);
}
export async function sourcePaths(root) {
  const paths = [...rootFiles];
  for (const directory of roots) await collect(root, directory, paths);
  return paths.sort();
}
export async function exportSource(root, destination) {
  root = await realpath(root);
  const output = resolve(root, "output");
  destination = resolve(destination);
  if (dirname(destination) !== output) throw new Error("Destination must be a new direct child of output/");
  const paths = await sourcePaths(root);
  const files = [];
  for (const path of paths.sort()) {
    const target = resolve(root, path);
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
    const rel = relative(root, await realpath(target));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Outside source root");
    const data = await readFile(target);
    if (/\.(?:ts|tsx|js|mjs|json|md|yaml|toml|txt|html|sh|rs)$/.test(path) || path === ".env.example") {
      const text = data.toString("utf8");
      if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(text)) throw new Error(`Private key detected: ${path}`);
      if (/https:\/\/www\.honesttai\.com\/app\/?/i.test(text)) throw new Error(`Hosted trial URL detected: ${path}`);
    }
    files.push({ path, data });
  }
  for (const required of ["apps/worker/src/index.ts", "packages/metrics/src/visibility.ts", "packages/evidence/src/schema.ts", "apps/web/src/App.tsx", "apps/desktop/src-tauri/src/main.rs"]) {
    if (!files.some(file=>file.path===required)) throw new Error(`Required full source missing: ${required}`);
  }
  if (!files.some(file=>file.path.startsWith("packages/core/migrations/")&&file.path.endsWith(".sql"))) throw new Error("Migrations missing");
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink() || await realpath(output) !== output) throw new Error("Output symlink refused");
  await mkdir(destination);
  for (const { path, data } of files) {
    const target = resolve(destination,path);
    await mkdir(dirname(target),{recursive:true});
    await writeFile(target,data,{flag:"wx"});
  }
  const manifest = { format: "zzgeo.full-source.v1", license: "AGPL-3.0-only", files: files.map(({path,data})=>({ path, bytes:data.length, sha256:createHash("sha256").update(data).digest("hex") })) };
  await writeFile(resolve(destination,"SOURCE_MANIFEST.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
  return manifest;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
  if(process.argv.length!==3)throw new Error("Usage: corepack pnpm export-source output/<new-directory>");
  const result=await exportSource(root,resolve(root,process.argv[2]));
  console.log(`Exported ${result.files.length} full-source files with checksums; no Git history or local environment included.`);
}
