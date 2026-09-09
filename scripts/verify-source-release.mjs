import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedPath, sourcePaths } from "./export-source.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const archive=resolve(root,"landing/source/zzgeo-source.zip");
const manifest=JSON.parse(await readFile(`${archive}.manifest.json`,"utf8"));
if(manifest.format!=="zzgeo.full-source.v1"||manifest.license!=="AGPL-3.0-only")throw new Error("A full AGPL source archive is required before release");
const expected=(await readFile(`${archive}.sha256`,"utf8")).trim().split(/\s+/)[0];
if(createHash("sha256").update(await readFile(archive)).digest("hex")!==expected)throw new Error("Source ZIP checksum mismatch");
const paths=new Set();
for(const entry of manifest.files){
  if(!allowedPath(entry.path)||paths.has(entry.path))throw new Error("Invalid source manifest path");
  paths.add(entry.path);
  const bytes=await readFile(resolve(root,entry.path));
  if(createHash("sha256").update(bytes).digest("hex")!==entry.sha256)throw new Error(`Source archive is stale: ${entry.path}`);
}
for(const path of await sourcePaths(root))if(!paths.has(path))throw new Error(`New source file missing from archive: ${path}`);
for(const path of ["LICENSE.md","NOTICE","apps/web/src/App.tsx","apps/worker/src/index.ts","packages/core/src/schema.ts","packages/metrics/src/visibility.ts","packages/search-providers/src/index.ts","apps/desktop/src-tauri/src/main.rs"])if(!paths.has(path))throw new Error(`Full source archive missing ${path}`);
console.log(`Source release verified: ${paths.size} files match the current working tree.`);
