import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guide } from "./public-guide-data.mjs";

const require = createRequire(resolve("apps/worker/package.json"));
const { load } = require("cheerio");
const origin = "https://www.honesttai.com";
const repository = "https://github.com/honestTai/geo-console";
const pages = [
  { file: "index.html", path: "/", title: "ZZ Geo | 开源 AI 搜索监测与内容优化工作台", description: "查看品牌在 AI 回答中的提及与来源，管理官网审计、内容整改和复测报告。完整开源，支持 Docker 自行部署。", markdown: "/index.md", type: "WebPage" },
  { file: "help/index.html", path: "/help/", title: "ZZ Geo 帮助中心与操作手册", description: "从客户建档、AI 监测、证据与官网审计，到内容质检、人工发布和复测报告的图文操作手册。", markdown: "/help/index.md", type: "TechArticle" },
  { file: "licensing.html", path: "/licensing.html", title: "完整开源与技术服务 | ZZ Geo", description: "ZZ Geo 使用 AGPL-3.0-only，允许依协议商用。了解源码获取、第三方许可及可选技术服务。", markdown: null, type: "WebPage" },
];

export async function buildDiscovery() {
  for (const page of pages) {
    const file = resolve("landing", page.file);
    const $ = load(await readFile(file, "utf8"));
    $("title").text(page.title);
    $('meta[name="description"],meta[property^="og:"],meta[name^="twitter:"],link[rel="canonical"],link[rel="describedby"],link[rel="alternate"][type="text/markdown"],script[data-discovery]').remove();
    const meta = (attributes) => $("<meta>").attr(attributes).appendTo("head");
    meta({ name: "description", content: page.description });
    for (const [property, content] of Object.entries({ "og:title": page.title, "og:description": page.description, "og:type": page.type === "TechArticle" ? "article" : "website", "og:url": origin + page.path, "og:site_name": "ZZ Geo", "og:locale": "zh_CN", "og:image": origin + "/help/assets/current/remediation.jpg", "og:image:alt": "ZZ Geo 整改中心，实际界面已脱敏" })) meta({ property, content });
    meta({ name: "twitter:card", content: "summary_large_image" });
    $("<link>").attr({ rel: "canonical", href: origin + page.path }).appendTo("head");
    $("<link>").attr({ rel: "describedby", href: "/llms.txt", type: "text/plain" }).appendTo("head");
    if (page.markdown) $("<link>").attr({ rel: "alternate", href: page.markdown, type: "text/markdown" }).appendTo("head");
    const graph = [
      { "@type": "WebSite", "@id": origin + "/#website", name: "ZZ Geo", url: origin + "/", inLanguage: "zh-CN" },
      { "@type": page.type, "@id": origin + page.path + "#page", name: page.title, description: page.description, url: origin + page.path, inLanguage: "zh-CN", isPartOf: { "@id": origin + "/#website" } },
    ];
    if (page.path === "/") graph.push({ "@type": "SoftwareSourceCode", name: "ZZ Geo", description: page.description, codeRepository: repository, programmingLanguage: "TypeScript", license: "https://www.gnu.org/licenses/agpl-3.0.html", url: origin + "/", runtimePlatform: "Node.js 24" });
    $("<script>").attr({ type: "application/ld+json", "data-discovery": "true" }).text(JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replaceAll("<", "\\u003c")).appendTo("head");
    await writeFile(file, $.html());
  }
  // Index only canonical public HTML pages. Do not publish guessed dates or fragment URLs.
  const sitemap = load('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', { xml: true });
  for (const page of pages) sitemap("urlset").append(sitemap("<url/>").append(sitemap("<loc/>").text(origin + page.path)));
  await writeFile("landing/sitemap.xml", sitemap.xml() + "\n");
  await writeFile("landing/robots.txt", `User-agent: *\nDisallow: /\nAllow: /$\nAllow: /help/\nAllow: /licensing.html$\nAllow: /assets/\nAllow: /site.css$\nAllow: /index.md$\nAllow: /llms.txt$\nAllow: /llms-full.txt$\nAllow: /sitemap.xml$\n\nSitemap: ${origin}/sitemap.xml\n`);
  const summary = `# ZZ Geo\n\n> ZZ Geo 是采用 AGPL-3.0-only 的开源 AI 搜索监测与内容运营工作台，面向品牌团队和 GEO 服务机构。\n\n项目支持客户建档、问题研究、供应商联网 API 采样、回答证据、官网审计、内容整改、文章质检、人工发布记录和同配置复测报告。完整代码公开，无专有核心依赖。\n\n监测平台包括 DeepSeek、Kimi、豆包火山方舟、通义千问 DashScope，以及“元宝搜索源 + 混元合成”。采样不等同于消费端 App 回答。失败和未知状态不填充为零；同配置复测不单独证明因果效果，不保证排名、收录或收益。\n\n官网 Demo 使用浏览器内存中的模拟记录，不连接业务 API。帮助截图来自实际系统并已脱敏。官方体验账号通过 honest.tai@outlook.com 私下申请，不开放自助注册。\n\n可按 AGPL-3.0 商用，修改、分发及网络服务须遵守适用条款。服务器和供应商 API 费用由使用者承担。部署、培训、维护和定制是可选服务。\n\nHRouter（https://hrouter.net/）是本项目赞助商，品牌标识不代表对效果的背书。\n`;
  await writeFile("landing/index.md", summary + `\n## 项目入口\n\n- [完整源码](${repository})\n- [操作手册](${origin}/help/index.md)\n- [Docker 一键启动](${repository}/blob/main/docs/docker-quickstart.md)\n- [许可证](${origin}/LICENSE.txt)\n`);
  const manual = `# ZZ Geo 操作手册\n\n以下说明与公开帮助网页来自同一份内容。\n\n` + guide.map(item => `## ${item.title}\n\n${item.intro}\n\n${item.steps.map((step,index)=>`${index+1}. ${step}`).join("\n")}\n\n完成后：${item.result}\n\n注意：${item.note}\n`).join("\n");
  await writeFile("landing/help/index.md", manual);
  await writeFile("landing/llms-full.txt", summary + "\n" + manual);
  await writeFile("landing/llms.txt", `# ZZ Geo\n\n> 开源 AI 搜索监测与内容运营工作台，AGPL-3.0-only，支持自行部署与依协议商用。\n\n采样来自供应商联网 API，不等同于消费端 App 回答。元宝渠道为“元宝搜索源 + 混元合成”。官网 Demo 是隔离模拟环境；不保证排名、收录或收益。\n\n## 产品与使用\n\n- [产品说明](${origin}/index.md): 能力、使用成本、许可和体验申请。\n- [操作手册](${origin}/help/index.md): 建档、监测、证据、整改、文章、发布与报告流程。\n- [Docker 一键启动](${repository}/blob/main/docs/docker-quickstart.md): 环境要求、随机密钥、启动与停止。\n- [完整说明](${origin}/llms-full.txt): 产品和操作手册的合并文本。\n\n## 源码与许可\n\n- [GitHub 仓库](${repository}): 全部业务源码、构建与部署文件。\n- [AGPL-3.0 全文](${origin}/LICENSE.txt): 使用、修改、分发及网络服务义务。\n- [指标口径](${repository}/blob/main/docs/visibility-measurement-v2.md): 分母、汇总与比较边界。\n\n## Optional\n\n- [赞助商 HRouter](https://hrouter.net/): 多模型 API 路由服务。\n`);
  console.log("Built robots, sitemap, llms.txt/full text, public Markdown and structured metadata.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await buildDiscovery();
