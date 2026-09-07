/** Technical guidance only. Findings must still be backed by this run's observations. */
export const websiteGuidance: Record<string, { selector: string; recommendation: string; verification: string }> = {
	A1: {
		selector: "HTTP 响应 / body",
		recommendation: "排查 DNS、网络、服务器响应与 WAF；保留可公开读取的关键业务正文。",
		verification: "从公网按相同 URL 复核响应与正文，再新建审计；访问失败不等于网站内容缺失。",
	},
	A2: {
		selector: "TLS / 最终 URL",
		recommendation: "核对证书域名、有效期与证书链，配置正确 HTTPS 重定向。",
		verification: "标准 TLS 校验通过，完整重定向链无错误。",
	},
	A3: {
		selector: "robots.txt / User-agent, Allow, Disallow",
		recommendation: "按业务意愿复核各机器人访问范围；检查 robots 与 CDN/WAF 是否一致。",
		verification: "用相同 UA 重检实际路径；robots 允许不保证被收录或引用。",
	},
	A4: {
		selector: "robots.txt Sitemap / urlset / sitemapindex",
		recommendation:
			"提供可读取的 XML Sitemap，在 robots.txt 声明真实地址；索引应指向有效子地图。导航菜单或 HTML 网站地图不能替代 XML。",
		verification: "子地图能够展开为有效页面 URL；抽查 URL 状态与 canonical 一致，报告中披露扫描上限与失败地址。",
	},
	A5: {
		selector: "head > title",
		recommendation: "为页面设置简洁、唯一、与业务正文一致的标题，避免重复堆砌企业别名。",
		verification: "查看源码中的 title，并确认与页面实际主题一致。",
	},
	A6: {
		selector: "meta[name=description]",
		recommendation: "提供可核验的页面摘要，不堆砌关键词或不可证实的承诺。",
		verification: "摘要存在且与正文事实一致；有标签不代表搜索平台一定使用。",
	},
	A7: {
		selector: "h1, h2",
		recommendation: "使用语义化主标题和分级小节；主标题应清晰表达本页主题。",
		verification: "核对 H1/H2 的实际文本和层级；仅图片、菜单和大号字体不视为语义标题。",
	},
	A8: {
		selector: "link[rel=canonical]",
		recommendation: "为重复或参数页面声明正确的规范 URL，避免指向错误域名或失效页面。",
		verification: "检查绝对 canonical URL 与实际页面内容、状态及站点地图一致。",
	},
	A9: {
		selector: "html[lang]",
		recommendation: "声明与正文主要语言匹配的 lang；中文内容不应仅因填写 en 就视为验证充分。",
		verification: "核对源码 lang 与实际正文语言，必要时逐页设置。",
	},
	A10: {
		selector: "script[type='application/ld+json']",
		recommendation: "依据页面实际实体使用适合的 Schema.org 类型，确保名称、网址与可见内容一致；不要捏造资质或评价。",
		verification: "JSON 可解析、实体字段可在正文验证；结构化数据不是排名保证。",
	},
	A11: {
		selector: "title / meta description / body / JSON-LD",
		recommendation: "统一企业全称和经确认的品牌别名，在关于我们、联系页与结构化数据中提供一致身份。",
		verification: "与当前已确认品牌白名单逐项核对；简称须先经人工确认，不能由模型自动当成同一主体。",
	},
	A12: {
		selector: "body / 联系与主体信息",
		recommendation: "展示真实联系方式、主体信息与可核验的业务资料；不要发布非必要个人隐私。",
		verification: "人工核验联系方式和主体事实；命中关键词仅表示观察到信号。",
	},
	A13: {
		selector: "/llms.txt",
		recommendation: "可选提供面向模型的内容索引；优先修复真实页面可访问性和事实表达。",
		verification: "该文件仅参考，不作为排名、收录或引用的必要条件。",
	},
};
