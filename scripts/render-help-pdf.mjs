import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(resolve("apps/worker/package.json"));
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless:true, ...(process.env.GEO_PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.GEO_PLAYWRIGHT_EXECUTABLE_PATH} : {}) });
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(process.argv[2] || "http://127.0.0.1:4194/help/",{waitUntil:"networkidle"});
  await page.evaluate(async()=>{for(const image of document.images)image.loading="eager";await Promise.all([...document.images].map(image=>image.decode()));await document.fonts.ready;});
  await page.pdf({path:resolve("landing/help/ZZ-Geo-操作手册.pdf"),format:"A4",printBackground:true,displayHeaderFooter:true,headerTemplate:"<div></div>",footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;color:#8290a0">ZZ Geo / Product Guide <span class="pageNumber"></span> / <span class="totalPages"></span></div>',preferCSSPageSize:true});
  console.log("Rendered current help HTML to PDF.");
} finally {await browser.close();}
