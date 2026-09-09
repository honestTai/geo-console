import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const session = "zzgeo-open-source-docs";
const redactions = JSON.parse(process.env.GEO_HELP_REDACTIONS || "[]");
if (!Array.isArray(redactions) || redactions.some(value => typeof value !== "string" || !value)) throw new Error("GEO_HELP_REDACTIONS must be a JSON array of nonempty text values");
const directory = resolve("landing/help/assets/current");
const headings = { workbench: "AI 工作台", overview: "可见度总览", monitoring: "五平台联网监测", evidence: "联网搜索记录", audit: "官网 AI 可读性检查", diagnosis: "可整改差距", remediation: "任务管理", articles: "文章管理", knowledge: "客户知识资产", attribution: "业务归因", report: "报告与交付", publications: "发布工作台", customers: "客户管理", questions: "行业问题知识库", settings: "模型与联网平台", members: "机构成员", "audit-logs": "审计日志", "runtime-logs": "运行日志", permissions: "角色与授权", organizations: "多租户管理" };
const views = [
  ["workbench", "AI 工作台"], ["overview", "项目总览"], ["monitoring", "AI 监测"],
  ["evidence", "证据中心"], ["audit", "官网审计"], ["diagnosis", "差距诊断"],
  ["remediation", "整改中心"], ["articles", "优化文章"], ["knowledge", "客户知识资产"],
  ["attribution", "业务归因"], ["report", "复测报告"], ["publications", "发布工作台"],
  ["customers", "客户管理"], ["questions", "问题知识库"], ["settings", "平台设置"],
  ["members", "机构成员"], ["audit-logs", "审计日志"], ["runtime-logs", "运行日志"],
  ["permissions", "权限配置"], ["organizations", "多租户管理"],
];
headings.attribution = "业务数据对照";
async function command(action, args = {}) {
  const response = await fetch("http://127.0.0.1:10086/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, args, session }) });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.message || `Failed: ${action}`);
  return result.data;
}
const evaluate = async code => (await command("evaluate", { code })).value;
await mkdir(directory, { recursive: true });
await command("cdp", { method: "Emulation.setDeviceMetricsOverride", params: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false } });
const records = [];
for (const [file, label] of views) {
  const exists = await evaluate(`(() => { const node = [...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(label)}); if(!node)return false;node.click(); return true; })()`);
  if (!exists) throw new Error(`Menu unavailable: ${label}`);
  for (let attempt = 0; attempt < 32; attempt++) {
    if (await evaluate(`document.querySelector('h1')?.textContent?.trim()===${JSON.stringify(headings[file])} && !document.querySelector('main .ant-spin-spinning')`)) break;
    if (attempt === 31) throw new Error(`View did not settle: ${label}`);
    await new Promise(r=>setTimeout(r,250));
  }
  await new Promise(r=>setTimeout(r,700));
  const facts = await evaluate(`(() => { const main=document.querySelector('main');return {heading:document.querySelector('h1')?.textContent,buttons:[...main.querySelectorAll('button')].map(n=>n.textContent.trim()).filter(Boolean).filter(t=>t.length<32).slice(0,25),empty:[...main.querySelectorAll('.ant-empty-description')].map(n=>n.textContent)}; })()`);
  // Change only the rendered document, then restore it. Never submit edits or alter API evidence.
  await evaluate(`(() => {
    window.__geoPublicRestore=[];
    const save=(node,key,value)=>{window.__geoPublicRestore.push([node,key,node[key]]);node[key]=value};
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const node of nodes){if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue; let value=node.nodeValue;
      for(const sensitive of ${JSON.stringify(redactions)})value=value.split(sensitive).join('示例项目');
      value=value
        .replace(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/g,'user@example.com')
        .replace(/(?:https?:\\/\\/)?(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:\\/[^\\s，。；）]*)?/g,'example.com')
        .replace(/\\b[0-9a-f]{8}-[0-9a-f-]{27,36}\\b/gi,'已脱敏')
        .replace(/(?:sk-|Bearer )[A-Za-z0-9._-]+/g,'[已隐藏]');
      if(value.trim().length>65&&!node.parentElement.closest('button,[role=menuitem],h1,h2,h3'))value='[业务内容已脱敏]';
      if(value!==node.nodeValue)save(node,'nodeValue',value);
    }
    document.querySelectorAll('input,textarea').forEach(n=>{if(n.value&&n.type!=='checkbox'&&n.type!=='radio')save(n,'value','');});
    document.querySelectorAll('.wb-bubble-body,.ant-table-tbody').forEach(n=>{window.__geoPublicRestore.push([n.style,'filter',n.style.filter]);n.style.filter='blur(8px)';});
    const mark=document.createElement('div');mark.id='geo-public-watermark';mark.textContent='ZZ Geo · 实际界面 / 业务数据已脱敏';mark.style.cssText='position:fixed;right:20px;bottom:15px;z-index:999999;background:#172b3d;color:white;padding:8px 12px;border-radius:4px;font:12px sans-serif';document.body.append(mark);window.scrollTo(0,0);return true;
  })()`);
  await command("screenshot", { format: "jpeg", quality: 88, path: resolve(directory, `${file}.jpg`) });
  await evaluate(`(() => {for(const [node,key,value]of(window.__geoPublicRestore||[]))node[key]=value;delete window.__geoPublicRestore;document.getElementById('geo-public-watermark')?.remove();return true;})()`);
  records.push({ file: `${file}.jpg`, label, ...facts });
  console.log(`Captured: ${label}`);
}
await command("cdp", { method: "Emulation.clearDeviceMetricsOverride", params: {} });
await writeFile(resolve("output/help-capture-facts.json"), JSON.stringify(records,null,2));
console.log(`Captured ${records.length} redacted interface screenshots.`);
