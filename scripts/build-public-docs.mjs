import { writeFile } from "node:fs/promises";
import { guide, guideVersion } from "./public-guide-data.mjs";

const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
let lastGroup = "";
const links = guide.map(item => {
  const heading = item.group !== lastGroup ? `<p class="toc-group">${escape(item.group)}</p>` : "";
  lastGroup = item.group;
  return `${heading}<a href="#${item.id}">${escape(item.title)}</a>`;
}).join("\n");
const sections = guide.map((item,index) => `<section class="help-section" id="${item.id}">
  <div class="chapter"><span>${String(index+1).padStart(2,"0")} / ${escape(item.group)}</span><h2>${escape(item.title)}</h2><p>${escape(item.intro)}</p></div>
  ${item.image ? `<figure class="screenshot"><a href="assets/current/${item.image}.jpg" target="_blank" rel="noopener" aria-label="查看${escape(item.title)}截图原图"><img src="assets/current/${item.image}.jpg" width="1440" height="1000" alt="${escape(item.title)}实际界面，业务数据已脱敏" loading="lazy"></a><figcaption>${escape(item.title)} · 实际界面 / ${guideVersion} / 业务数据已脱敏，保留真实空状态</figcaption></figure>` : ""}
  <h3>操作步骤</h3><ol>${item.steps.map(step=>`<li>${escape(step)}</li>`).join("")}</ol>
  <div class="expected"><strong>完成后</strong><p>${escape(item.result)}</p></div><p class="notice"><strong>注意：</strong>${escape(item.note)}</p>
</section>`).join("\n");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f5f7fa"><title>ZZ Geo 帮助中心与操作手册</title><meta name="description" content="从客户建档、AI 监测、证据与官网审计，到内容质检、人工发布和复测报告的图文操作手册。"><link rel="icon" href="../assets/brand.svg"><link rel="stylesheet" href="styles.css"><script src="app.js" defer></script></head>
<body><a class="skip-link" href="#manual">跳到正文</a><header class="help-topbar"><a class="help-brand" href="../index.html"><img src="../assets/brand.svg" width="30" height="30" alt=""><strong>ZZ Geo</strong><span>帮助中心</span></a><label class="help-search"><span class="sr-only">搜索操作手册</span><input id="helpSearch" type="search" placeholder="搜索操作、页面或问题" autocomplete="off"></label><div class="top-actions"><button type="button" id="printManual" title="打印完整手册">打印</button><a href="ZZ-Geo-操作手册.pdf" download>下载 PDF</a><a class="trial-link" href="mailto:honest.tai@outlook.com?subject=ZZ%20Geo%20申请体验账号">申请体验</a></div></header>
<div class="help-layout"><aside class="help-sidebar"><p class="toc-title">操作手册 <span>${guideVersion}</span></p><nav aria-label="章节目录">${links}</nav><a class="toc-home" href="../index.html">返回官网 ↗</a></aside><main class="help-main" id="manual"><div class="manual-intro"><p class="eyebrow">ZZ GEO / PRODUCT GUIDE</p><h1>从第一个客户，<br>到一份可复核的交付。</h1><p>按真实工作流程了解监测、证据、整改和报告。<br>每一步都说明操作前提、完成结果和需要留意的边界。</p><div class="manual-meta"><span>完整开源 · AGPL-3.0</span><span>图文手册 · ${guideVersion}</span></div><p class="intro-note">截图来自当前系统，客户身份与业务内容已脱敏。空状态表示当时没有对应数据，不是功能缺失。页面和操作随账号权限变化。</p></div><label class="mobile-toc">跳转章节 <select id="mobileTocSelect">${guide.map(item=>`<option value="${item.id}">${escape(item.title)}</option>`).join("")}</select></label><div id="searchEmpty" class="search-empty" role="status">没有匹配的章节，请更换搜索词。</div>${sections}<footer class="page-footer">ZZ Geo · 完整开源 / 技术服务与体验申请：honest.tai@outlook.com<br>项目采用 AGPL-3.0；第三方组件保留原有许可。</footer></main></div></body></html>`;
await writeFile("landing/help/index.html",html);
const markdown = `# ZZ Geo 操作手册\n\n版本：${guideVersion}。实际系统截图已经脱敏；无数据页面保持真实空状态。\n\n体验账号请联系 honest.tai@outlook.com，由管理员私下提供登录方式。\n\n` + guide.map(item=>`## ${item.title}\n\n${item.intro}\n\n${item.image ? `![${item.title}](../landing/help/assets/current/${item.image}.jpg)\n\n`:""}${item.steps.map((step,index)=>`${index+1}. ${step}`).join("\n")}\n\n完成后：${item.result}\n\n注意：${item.note}\n`).join("\n");
await writeFile("docs/user-guide.md",markdown);
console.log(`Built ${guide.length} help chapters and ${guide.filter(item=>item.image).length} screenshot references.`);
