import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { guide } from "./public-guide-data.mjs";
const require = createRequire(resolve("apps/worker/package.json"));
const { load } = require("cheerio");
const root=resolve("landing");
const allowSourcePending=process.argv.includes("--source-pending");
for(const file of ["index.html","licensing.html","demo.html","help/index.html"]){
  const html=await readFile(resolve(root,file),"utf8");
  const $=load(html);
  assert.equal($("h1").length,1,`${file}: one H1 required`);
  for(const element of $("a[href],img[src],link[href],script[src]").toArray()){
    const url=$(element).attr("href")||$(element).attr("src");
    assert.ok(!/^(?:https?:\/\/[^/]+)?\/(?:app|api|artifacts|share)(?:\/|$)/i.test(url),`${file}: private experience link`);
    if(/^(?:https?:|mailto:|data:)/.test(url))continue;
    const [path,anchor]=url.split("#");
    if(!path&&anchor){assert.equal($(`[id="${anchor}"]`).length,1,`${file}: missing anchor ${anchor}`);continue;}
    if(allowSourcePending&&path.startsWith("source/"))continue;
    const target=path.startsWith("/")?resolve(root,`.${path}`):resolve(dirname(resolve(root,file)),path.split("?")[0]);
    await access(path.endsWith("/")?resolve(target,"index.html"):target);
  }
}
const help=load(await readFile(resolve(root,"help/index.html"),"utf8"));
assert.equal(help(".help-section").length,guide.length);
assert.equal(help(".screenshot img").length,20);
for(const item of guide)assert.equal(help(`#${item.id}`).length,1);
assert.equal((await readdir(resolve(root,"help/assets/current"))).filter(name=>name.endsWith(".jpg")).length,20);
for(const name of ["README.md","landing/index.html","landing/licensing.html","landing/help/index.html","docs/user-guide.md"]){
  const content=await readFile(name,"utf8");
  assert.ok(!content.includes("https://www.honesttai.com/"+"app/"),`${name}: experience address leaked`);
  assert.ok(!/仅限非商业|另行商业授权|私有核心独立授权/.test(content),`${name}: outdated license wording`);
}
console.log(`Public docs valid: ${guide.length} chapters, 20 current screenshots, no public trial links.`);
const home=load(await readFile(resolve(root,"index.html"),"utf8"));
assert.equal(home(".platform-list img").length,5);
assert.equal(home('a.partner-visit[href="https://hrouter.net/"]').length,1);
assert.ok(home('a[href="https://github.com/honestTai/geo-console"]').length>=1);
assert.equal(home('iframe[src="interactive/preview.html"]').length,1);
assert.ok(!home('iframe').attr('sandbox').includes('allow-same-origin'));
const demo=await readFile("apps/web/preview.html","utf8");
assert.ok(demo.includes("connect-src 'none'"));
console.log("Five platform logos, explicit sponsor/GitHub links and isolated Demo verified.");
