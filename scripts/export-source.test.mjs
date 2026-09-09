import assert from "node:assert/strict";
import test from "node:test";
import { allowedPath } from "./export-source.mjs";
test("full implementation and reproducible build inputs are included",()=>{
  for(const path of ["apps/web/src/App.tsx","apps/worker/src/agent.ts","packages/core/migrations/0001_init.sql","packages/metrics/src/visibility.ts","apps/desktop/src-tauri/src/main.rs","apps/desktop/src-tauri/Cargo.lock","pnpm-lock.yaml","pnpm-workspace.yaml",".env.example","deploy/package.sh"])assert.equal(allowedPath(path),true,path);
});
test("environment, history, outputs, credentials and source archive recursion are excluded",()=>{
  for(const path of [".git/config",".env",".env.production",".agents/skills/geo-deployment/SKILL.md","apps/web/.env","apps/desktop/src-tauri/target/foo","apps/web/dist/index.html","packages/core/node_modules/module.js","landing/source/zzgeo-source.zip","apps/worker/secrets/key.txt","apps/worker/src/key.pem","../README.md","apps/../README.md","C:/secrets.txt","apps\\worker\\src.ts","docs/full-audit-2026-09-06.md"])assert.equal(allowedPath(path),false,path);
});
test("interactive demo source and Docker quickstart are public, local secrets and built demo are not",()=>{
  for(const path of ["apps/web/src/preview/ProductPreview.tsx","apps/web/preview.html","apps/web/vite.preview.config.ts","docker/quickstart/start.sh","docker/quickstart/start.ps1","docker/quickstart/compose.yaml"])assert.equal(allowedPath(path),true,path);
  for(const path of [".quickstart/config.env",".quickstart/secrets/master_key","landing/interactive/assets/preview.js"])assert.equal(allowedPath(path),false,path);
});
