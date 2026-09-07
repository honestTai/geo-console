/** Plain-language explanations of observed checks, not claims that a defect causes ranking changes. */
export const websiteScoreGuide = {
	label: "首页技术检查得分",
	meaning: "只衡量本次首页技术检查通过情况，不是企业质量或 AI 推荐排名。",
	formula:
		"通过项得到全部权重，警告项得到一半权重，失败项为 0；得分 = 已得权重 ÷ 适用项目总权重 × 100（四舍五入）。参考项不计入分母。",
	caution: "没有可评分证据显示未评分，不是零分；不同检查项目/范围的分数不能直接比较。",
};
export function websiteScoreBreakdown(checks: Array<{ weight: number; status: string }>): string {
	const applicable = checks.filter((c) => c.status !== "skip" && c.weight > 0);
	const total = applicable.reduce((sum, c) => sum + c.weight, 0);
	const earned = applicable.reduce(
		(sum, c) => sum + c.weight * (c.status === "pass" ? 1 : c.status === "warning" ? 0.5 : 0),
		0,
	);
	return `本次计分权重：${earned} / ${total}；共 ${applicable.length} 项适用检查。`;
}
export const websiteCheckLanguage: Record<string, { label: string; meaning: string; owner: string }> = {
	A1: {
		label: "网页能否正常打开",
		meaning: "访问失败时，机器可能无法读取页面；只说明本次访问结果，不推断全站状态。",
		owner: "网站技术负责人",
	},
	A2: {
		label: "网页连接是否安全",
		meaning: "检查 HTTPS 连接；已通过就不需要为这一项重复整改。",
		owner: "网站技术负责人",
	},
	A3: {
		label: "有没有阻止搜索机器人读取",
		meaning: "检查机器人访问规则，不同机器人规则可能不同；允许访问不代表一定收录。",
		owner: "网站技术负责人",
	},
	A4: {
		label: "能否找到供机器读取的网址清单",
		meaning:
			"网址清单叫 Sitemap，和导航菜单不同。未发现时先核对实际地址和抓取响应，再决定补建；不能凭有限扫描认定全站不存在。",
		owner: "网站技术负责人",
	},
	A5: {
		label: "页面标题是否清楚",
		meaning: "标题应准确说明本页业务，而不是无关词或只有公司口号。",
		owner: "内容负责人 / 网站技术负责人",
	},
	A6: {
		label: "页面有没有准确的内容摘要",
		meaning: "摘要需要与页面正文一致；存在摘要不代表 AI 一定使用。",
		owner: "内容负责人",
	},
	A7: {
		label: "页面主标题与小标题是否明确",
		meaning: "主标题对应代码 H1，小标题对应 H2。大号字体或图片文字不一定有机器可识别的标题结构。",
		owner: "网站技术负责人 / 内容负责人",
	},
	A8: {
		label: "是否说明哪个网址是页面的主要版本",
		meaning: "Canonical 是给重复或带参数页面指定主要网址，避免页面归属混乱。",
		owner: "网站技术负责人",
	},
	A9: {
		label: "页面声明的语言是否与正文一致",
		meaning: "页面中文正文应核对语言标记，而不是只检查有没有 lang 属性。",
		owner: "网站技术负责人",
	},
	A10: {
		label: "有没有机器能直接读取的公司与服务信息",
		meaning: "结构化数据（JSON-LD）是机器可读的信息卡，应与可见的名称、业务和联系方式一致，不能虚构评分或资质。",
		owner: "网站技术负责人 / 资料负责人",
	},
	A11: {
		label: "公司名称与品牌身份是否一致",
		meaning: "核对企业全称、确认的简称及页面事实，不能只因全文没出现企业全称就判定公司不存在。",
		owner: "内容负责人",
	},
	A12: {
		label: "主体与联系方式能否核实",
		meaning: "让读者能核对谁提供服务、如何联系；不公开非必要个人隐私。",
		owner: "资料负责人",
	},
	A13: {
		label: "可选的 AI 内容导航文件",
		meaning: "llms.txt 只是可选参考，不是收录、推荐或排名的必要条件，不应抢在真实问题前整改。",
		owner: "网站技术负责人（可选）",
	},
};
