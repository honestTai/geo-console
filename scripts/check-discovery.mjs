import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const { load } = createRequire(resolve("apps/worker/package.json"))("cheerio");
const origin="https://www.honesttai.com";
const sitemap=load(await readFile("landing/sitemap.xml","utf8"),{xml:true});
const urls=sitemap("loc").toArray().map(node=>sitemap(node).text());
assert.deepEqual(urls,[origin+"/",origin+"/help/",origin+"/licensing.html"]);
assert.equal(sitemap("lastmod").length,0);
for(const [file,url] of [["index.html",urls[0]],["help/index.html",urls[1]],["licensing.html",urls[2]]]){
  const $=load(await readFile(resolve("landing",file),"utf8"));
  assert.equal($('link[rel="canonical"]').length,1);
  assert.equal($('link[rel="canonical"]').attr("href"),url);
  assert.equal($('link[rel="describedby"]').attr("href"),"/llms.txt");
  const graph=JSON.parse($('script[data-discovery]').text());
  assert.equal(graph["@context"],"https://schema.org");
  assert.ok(graph["@graph"].some(item=>item.url===url));
  assert.ok(!JSON.stringify(graph).includes("aggregateRating"));
}
const robots=await readFile("landing/robots.txt","utf8");
assert.ok(robots.includes("Sitemap: "+origin+"/sitemap.xml"));
assert.ok(robots.includes("Disallow: /\n"));
for(const path of ["llms.txt","llms-full.txt","index.md","help/index.md"]){
  const text=await readFile(resolve("landing",path),"utf8");
  assert.ok(text.startsWith("# ZZ Geo"));
  assert.ok(!text.includes(origin+"/app"));
  assert.ok(!text.includes("api_key"));
  for(const match of text.matchAll(/\]\((https:\/\/www\.honesttai\.com[^)]*)\)/g)){
    const url=new URL(match[1]);
    await access(resolve("landing",`.${url.pathname.endsWith("/")?url.pathname+"index.html":url.pathname}`));
  }
}
console.log("Discovery checks passed: canonical URLs, sitemap, robots, JSON-LD, Markdown links and AI text boundaries.");
