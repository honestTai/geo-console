import assert from "node:assert/strict";
import { resolve } from "node:path";
const session="zzgeo-open-source-docs";
const origin=process.env.GEO_PUBLIC_SITE_URL || "http://127.0.0.1:4194";
async function command(action,args={}){
  const result=await (await fetch("http://127.0.0.1:10086/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,args,session})})).json();
  if(!result.ok)throw new Error(result.error?.message||action);
  return result.data;
}
const evaluate=async code=>(await command("evaluate",{code})).value;
await command("navigate",{url:origin+"/"});
await command("snapshot");
for(const width of [1440,1024]){
  await command("cdp",{method:"Emulation.setDeviceMetricsOverride",params:{width,height:1000,deviceScaleFactor:1,mobile:false}});
  const facts=await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,h1:document.querySelector('h1')?.textContent,privateLinks:[...document.querySelectorAll('a[href]')].filter(a=>/\\/(app|api|artifacts|share)(\\/|$)/.test(a.getAttribute('href'))).length})`);
  assert.equal(facts.overflow,false);assert.equal(facts.h1,"ZZ Geo");assert.equal(facts.privateLinks,0);
  await command("screenshot",{format:"png",path:resolve(`output/public-home-${width}.png`)});
}
await command("click",{selector:'[data-shot="agent"]'});
assert.equal(await evaluate(`document.getElementById('product-panel').getAttribute('aria-labelledby')`),"tab-agent");
await evaluate(`document.querySelector('[data-shot="agent"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));true`);
assert.equal(await evaluate(`document.getElementById('product-panel').getAttribute('aria-labelledby')`),"tab-articles");
await command("click",{selector:"details summary"});
assert.equal(await evaluate(`document.querySelector('details').open`),true);
await command("navigate",{url:origin+"/help/"});
await command("snapshot");
await command("fill",{selector:"#helpSearch",value:"人工发布"});
const results=await evaluate(`({visible:[...document.querySelectorAll('.help-section:not(.hidden)')].length,total:document.querySelectorAll('.help-section').length,overflow:document.documentElement.scrollWidth>innerWidth})`);
assert.ok(results.visible>0&&results.visible<results.total);assert.equal(results.total,21);assert.equal(results.overflow,false);
await command("fill",{selector:"#helpSearch",value:"no-matching-guide-98351"});
assert.equal(await evaluate(`document.getElementById('searchEmpty').classList.contains('visible')`),true);
await command("fill",{selector:"#helpSearch",value:""});
assert.equal(await evaluate(`document.querySelectorAll('.help-section:not(.hidden)').length`),21);
await command("screenshot",{format:"png",path:resolve("output/public-help-1024.png")});
await command("cdp",{method:"Emulation.clearDeviceMetricsOverride",params:{}});
console.log("Public site verified: desktop layouts, screenshot tabs/keyboard, FAQ, help search, no public trial links.");
