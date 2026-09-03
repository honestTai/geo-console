import { resolve } from "node:path";

const bridgeUrl = "http://127.0.0.1:10086/command";
const session = process.env.GEO_HELP_WEBBRIDGE_SESSION ?? "honesttai-help-docs-isolated";
const appUrl = process.env.GEO_HELP_APP_URL ?? "https://geo.example.com/app/";
const projectName = process.env.GEO_HELP_PROJECT_NAME;
const projectDomain = process.env.GEO_HELP_PROJECT_DOMAIN;
const screenshotDir = resolve("landing/help/assets/screenshots");

if (!projectName || !projectDomain)
	throw new Error("Set GEO_HELP_PROJECT_NAME and GEO_HELP_PROJECT_DOMAIN for the screenshot source project.");

async function command(action, args = {}) {
	const response = await fetch(bridgeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, args, session }),
	});
	const result = await response.json();
	if (!response.ok || !result.ok) throw new Error(result.error?.message ?? `WebBridge ${action} failed`);
	return result.data;
}

async function evaluate(code) {
	const result = await command("evaluate", { code });
	return result.value;
}

async function waitFor(code, description, timeoutMs = 12_000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await evaluate(code)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function clickText(text, selectors = "button,[role=menuitem],[role=tab]") {
	const clicked = await evaluate(`(() => {
		const expected = ${JSON.stringify(text)};
		const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
		const compact = (value) => normalize(value).replace(/\\s/g, "");
		const element = [...document.querySelectorAll(${JSON.stringify(selectors)})]
			.find((candidate) => normalize(candidate.innerText || candidate.textContent) === expected)
			?? [...document.querySelectorAll(${JSON.stringify(selectors)})]
				.find((candidate) => compact(candidate.innerText || candidate.textContent) === compact(expected));
		if (!element) return false;
		element.click();
		return true;
	})()`);
	if (!clicked) throw new Error(`Could not find control: ${text}`);
}

async function clearOverlays() {
	await evaluate(`(() => {
		document.querySelectorAll("[data-help-overlay]").forEach((element) => element.remove());
		return true;
	})()`);
}

async function annotate(callouts, scrollText = null) {
	const result = await evaluate(`(() => {
		const callouts = ${JSON.stringify(callouts)};
		const projectName = ${JSON.stringify(projectName)};
		const projectDomain = ${JSON.stringify(projectDomain)};
		const scrollText = ${JSON.stringify(scrollText)};
		const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
		const visible = (element) => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
		};
		const findByText = (text) => {
			const selectors = "button,[role=tab],[role=radio],[role=switch],input,textarea,h1,h2,h3,h4,h5,label,th,.ant-segmented-item,.ant-select-selector";
			const candidates = [...document.querySelectorAll(selectors)].filter(visible);
			return candidates.find((element) => normalize(element.innerText || element.textContent || element.placeholder) === text)
				?? candidates.find((element) => normalize(element.innerText || element.textContent || element.placeholder).includes(text))
				?? candidates.find((element) => normalize(element.innerText || element.textContent || element.placeholder).replace(/\\s/g, "") === text.replace(/\\s/g, ""));
		};
		if (scrollText) {
			const target = findByText(scrollText);
			target?.scrollIntoView({ block: "center", behavior: "instant" });
		} else {
			window.scrollTo({ top: 0, behavior: "instant" });
		}
		document.querySelectorAll("[data-help-overlay]").forEach((element) => element.remove());
		const targets = callouts.map((callout) => callout.selector
			? [...document.querySelectorAll(callout.selector)].find(visible)
			: findByText(callout.text));

		const replacements = [
			[projectName, "示例客户"],
			[projectDomain, "example.com"],
			[/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/g, "user@example.com"],
			[/\\b[0-9a-f]{8}-[0-9a-f-]{27,36}\\b/gi, "example-id"],
		];
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const textNodes = [];
		while (walker.nextNode()) textNodes.push(walker.currentNode);
		for (const node of textNodes) {
			let value = node.nodeValue || "";
			for (const [from, to] of replacements) value = value.replace(from, to);
			node.nodeValue = value;
		}
		document.querySelectorAll("input,textarea").forEach((element) => {
			if (element.value && element.type !== "date") element.value = element.type === "password" ? "••••••••••••" : "示例内容";
		});
		document.querySelectorAll(".project-home-card:not(.project-home-card-new)").forEach((card, index) => {
			const heading = card.querySelector(".project-home-card-name");
			if (heading) heading.textContent = "示例客户 " + String.fromCharCode(65 + index);
			const domain = [...card.querySelectorAll("p,span")].find((element) => /\\.[a-z]{2,}$/i.test(normalize(element.textContent)));
			if (domain) domain.textContent = "example" + (index + 1) + ".com";
		});

		const found = [];
		const motionStyle = document.createElement("style");
		motionStyle.dataset.helpOverlay = "motion";
		motionStyle.textContent = ".ant-modal-root,.ant-modal-mask,.ant-modal-wrap,.ant-modal,.ant-popover,.ant-dropdown,.ant-drawer,.ant-drawer-mask,.ant-drawer-content-wrapper{opacity:1!important;visibility:visible!important;transform:none!important;transition:none!important;animation:none!important}";
		document.head.append(motionStyle);
		for (const [index, callout] of callouts.entries()) {
			const target = targets[index];
			if (!target) {
				found.push({ number: index + 1, label: callout.label, found: false });
				continue;
			}
			const rect = target.getBoundingClientRect();
			if (rect.bottom < 0 || rect.top > innerHeight) {
				found.push({ number: index + 1, label: callout.label, found: false });
				continue;
			}
			const current = target.getBoundingClientRect();
			const overlay = document.createElement("div");
			overlay.dataset.helpOverlay = "callout";
			overlay.style.cssText = [
				"position:fixed",
				"left:" + Math.max(3, current.left - 4) + "px",
				"top:" + Math.max(3, current.top - 4) + "px",
				"width:" + Math.max(20, current.width + 8) + "px",
				"height:" + Math.max(20, current.height + 8) + "px",
				"border:3px solid #e5484d",
				"border-radius:7px",
				"background:rgba(229,72,77,.07)",
				"box-shadow:0 0 0 2px rgba(255,255,255,.9),0 4px 12px rgba(16,24,40,.18)",
				"pointer-events:none",
				"z-index:2147483646",
			].join(";");
			const badge = document.createElement("span");
			badge.textContent = String(index + 1);
			badge.style.cssText = "position:absolute;left:-14px;top:-14px;width:25px;height:25px;border-radius:50%;display:grid;place-items:center;background:#e5484d;color:#fff;border:2px solid #fff;font:700 13px/1 system-ui;box-shadow:0 2px 6px rgba(16,24,40,.28)";
			overlay.append(badge);
			document.body.append(overlay);
			found.push({ number: index + 1, label: callout.label, found: true });
		}
		const stamp = document.createElement("div");
		stamp.dataset.helpOverlay = "stamp";
		stamp.textContent = "ZZ Geo 帮助手册 · 示例界面";
		stamp.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:7px 11px;border-radius:6px;background:rgba(16,24,40,.88);color:#fff;font:600 12px/1.2 system-ui;letter-spacing:0;pointer-events:none";
		document.body.append(stamp);
		return JSON.stringify(found);
	})()`);
	const missing = JSON.parse(result).filter((item) => !item.found);
	if (missing.length) console.warn("Missing callouts:", missing.map((item) => item.label).join(", "));
}

async function screenshot(name, callouts, scrollText = null) {
	await annotate(callouts, scrollText);
	const result = await command("screenshot", {
		format: "jpeg",
		quality: 86,
		path: resolve(screenshotDir, `${name}.jpg`),
	});
	console.log(`${name}: ${result.path}`);
	await clearOverlays();
}

async function selectView(label) {
	await clickText(label, "[role=menuitem]");
	await waitFor(
		`() => document.querySelector(".topbar-view")?.textContent?.trim() === ${JSON.stringify(label)}`,
		`view ${label}`,
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}

const views = [
	{
		label: "AI 工作台",
		name: "03-workbench",
		callouts: [
			{ text: "新会话", label: "新建会话" },
			{ text: "测试此模型", label: "测试所选模型的联网能力" },
			{ text: "跑售前快审", label: "快捷指令" },
			{ text: "输入指令，例如：跑一次正式基线并生成报告", label: "指令输入框" },
			{ text: "发送", label: "发送指令" },
		],
	},
	{
		label: "项目总览",
		name: "04-overview",
		callouts: [
			{ text: "编辑监测范围", label: "编辑监测范围" },
			{ text: "品牌提及率", label: "核心指标" },
			{ text: "指标趋势", label: "同配置趋势" },
			{ text: "平台覆盖", label: "平台覆盖" },
		],
	},
	{
		label: "AI 监测",
		name: "05-monitoring",
		callouts: [
			{ text: "运行配置", label: "本次运行配置" },
			{ text: "按此条件复测", label: "同条件复测" },
			{ text: "运行售前快审", label: "运行售前快审" },
			{ text: "新建正式基线", label: "新建正式基线" },
			{ text: "再次运行监测", label: "再次运行所选批次" },
		],
	},
	{
		label: "证据中心",
		name: "07-evidence",
		callouts: [
			{ text: "导出证据 CSV", label: "导出证据" },
			{ text: "AI 回答", label: "回答证据分区" },
			{ text: "联网搜索", label: "联网搜索证据分区" },
			{ selector: ".ant-select-selector", label: "选择批次或平台" },
			{ selector: ".evidence-list button", label: "选择一条证据" },
		],
	},
	{
		label: "官网审计",
		name: "09-website-audit",
		callouts: [
			{ text: "重新审计", label: "重新审计官网" },
			{ text: "AI 可读性得分", label: "审计总分" },
			{ text: "首页读取结果", label: "首页技术摘要" },
			{ text: "审计项目", label: "逐项检查结果" },
		],
	},
	{
		label: "差距诊断",
		name: "10-diagnosis",
		callouts: [
			{ selector: ".ant-select-selector", label: "选择来源批次" },
			{ text: "HRouter Agent 诊断草稿", label: "生成 Agent 诊断草稿" },
			{ text: "生成证据诊断", label: "运行规则诊断" },
			{ text: "规则诊断结果", label: "规则诊断列表" },
		],
	},
	{
		label: "整改中心",
		name: "11-remediation",
		callouts: [
			{ text: "来源批次", label: "选择来源批次" },
			{ text: "HRouter Agent 规划草稿", label: "生成整改规划草稿" },
			{ text: "从已批准诊断建任务", label: "物化已批准诊断" },
			{ text: "生成内容草稿", label: "生成任务内容草稿" },
			{ text: "查看验收标准", label: "查看验收要求" },
		],
	},
	{
		label: "业务归因",
		name: "12-attribution",
		callouts: [
			{ selector: ".ant-select-selector", label: "选择数据来源" },
			{ text: "选择文件", label: "选择 CSV 文件" },
			{ text: "导入并校验", label: "校验并导入" },
			{ text: "还没有真实归因数据", label: "归因数据区域" },
		],
	},
	{
		label: "复测报告",
		name: "13-report",
		callouts: [
			{ selector: ".ant-select-selector", label: "选择报告批次" },
			{ text: "生成新报告版本", label: "推进报告工作流" },
			{ text: "交付", label: "导出与分享" },
			{ text: "总览", label: "报告总览" },
			{ text: "证据索引", label: "报告证据索引" },
		],
	},
	{
		label: "优化文章",
		name: "15-articles",
		callouts: [
			{ text: "交给 AI 工作台", label: "交给工作台自动处理" },
			{ text: "从报告生成文章", label: "按报告建议生成" },
			{ text: "全部", label: "按文章状态筛选" },
			{ text: "编辑", label: "编辑文章" },
			{ text: "重新生成", label: "按同一建议重新生成" },
			{ text: "删除文章", label: "删除文章" },
		],
	},
	{
		label: "问题知识库",
		name: "17-knowledge",
		callouts: [
			{ text: "导出知识库", label: "导出配置" },
			{ text: "导入知识库", label: "导入配置" },
			{ text: "按行业筛选，如：数控设备", label: "行业筛选" },
			{ text: "潜在客户会向 AI 提出的真实问题", label: "新问题" },
			{ text: "加入知识库", label: "保存新问题" },
		],
	},
	{
		label: "平台设置",
		name: "18-settings",
		callouts: [
			{ text: "导出配置", label: "导出平台配置" },
			{ text: "导入配置", label: "导入平台配置" },
			{ text: "刷新状态", label: "重新读取状态" },
			{ text: "保存模型配置", label: "保存 HRouter 配置" },
			{ text: "测试联网搜索", label: "测试模型联网" },
			{ text: "保存平台", label: "保存当前平台" },
		],
	},
	{
		label: "机构成员",
		name: "19-members",
		callouts: [
			{ text: "邮箱", label: "成员邮箱" },
			{ text: "选择角色", label: "成员角色" },
			{ text: "至少12位初始密码", label: "初始密码" },
			{ text: "添加成员", label: "添加成员" },
			{ text: "停用", label: "停用成员" },
		],
	},
	{
		label: "审计日志",
		name: "20-audit-logs",
		callouts: [
			{ text: "审计日志", label: "审计日志页" },
			{ text: "动作", label: "动作列" },
			{ text: "目标", label: "目标列" },
			{ text: "时间", label: "时间列" },
		],
	},
	{
		label: "运行日志",
		name: "21-service-logs",
		callouts: [
			{ text: "自动刷新", label: "自动刷新" },
			{ text: "导出 CSV", label: "导出日志" },
			{ text: "刷新", label: "立即刷新" },
			{ text: "ERROR", label: "按级别快速筛选" },
			{ text: "筛 选", label: "应用筛选条件" },
			{ text: "清理过期日志", label: "清理当前机构过期运行日志" },
		],
	},
	{
		label: "权限配置",
		name: "22-rbac",
		callouts: [
			{ text: "机构授权", label: "机构权限上限" },
			{ text: "角色权限", label: "角色权限" },
			{ text: "用户与客户范围", label: "用户权限与客户范围" },
			{ text: "保存机构授权", label: "保存机构权限上限" },
			{ text: "全选", label: "全选权限" },
			{ text: "清空", label: "清空权限" },
		],
	},
	{
		label: "多租户管理",
		name: "25-organizations",
		callouts: [
			{ text: "新建机构", label: "新建机构" },
			{ text: "搜索机构名称或 ID", label: "搜索机构" },
			{ text: "当前机构", label: "当前活动机构" },
			{ text: "封禁", label: "封禁机构" },
		],
	},
];

const selectedTab = await command("find_tab", { url: appUrl });
console.log(`Using WebBridge tab ${selectedTab.tabId}: ${selectedTab.url}`);
await evaluate(`location.reload(); true`);
await waitFor(
	`[...document.querySelectorAll("h1,h2")].some((node) => node.textContent?.includes("从一个真实客户开始"))`,
	"project selector",
);

await screenshot("01-projects", [
	{ text: "机构管理", label: "进入机构管理" },
	{ text: "新建客户", label: "新建客户" },
	{ text: "按客户名或域名筛选", label: "筛选客户" },
	{ text: projectName, label: "打开客户项目" },
]);

await evaluate(`location.reload(); true`);
await waitFor(
	`[...document.querySelectorAll("h1,h2")].some((node) => node.textContent?.includes("从一个真实客户开始"))`,
	"project selector after reload",
);

await clickText("新建客户");
await waitFor(`Boolean(document.querySelector(".ant-modal"))`, "new project dialog");
await new Promise((resolveWait) => setTimeout(resolveWait, 500));
await screenshot("02-create-project", [
	{ text: "客户名称", label: "客户名称" },
	{ text: "官网", label: "官网" },
	{ text: "目标地区", label: "目标地区" },
	{ text: "取消", label: "取消" },
	{ text: "创建并进入建档", label: "创建并进入建档" },
]);
await evaluate(`location.reload(); true`);
await waitFor(
	`[...document.querySelectorAll("h1,h2")].some((node) => node.textContent?.includes("从一个真实客户开始"))`,
	"project selector after closing the new project dialog",
);

const opened = await evaluate(`(() => {
	const expected = ${JSON.stringify(projectName)};
	const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5")].find((node) => node.textContent?.trim() === expected);
	if (!heading) return false;
	heading.click();
	return true;
})()`);
if (!opened) throw new Error(`Project card not found: ${projectName}`);
await waitFor(`document.querySelector(".topbar-project strong")?.textContent?.trim() === ${JSON.stringify(projectName)}`, "project workspace");

for (const view of views) {
	await selectView(view.label);
	await screenshot(view.name, view.callouts);
	if (view.label === "AI 监测") {
		await clickText("运行配置");
		await waitFor(`Boolean(document.querySelector(".ant-popover"))`, "run configuration popover");
		await screenshot("06-monitoring-config", [
			{ text: "本次监测平台", label: "选择平台" },
			{ text: "基线重复次数", label: "设置重复次数" },
		]);
		await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
	}
	if (view.label === "证据中心") {
		await clickText("联网搜索", "[role=tab],[role=radio],label,button");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await screenshot("08-web-search-evidence", [
			{ text: "AI 回答", label: "返回回答证据" },
			{ text: "联网搜索", label: "当前联网搜索分区" },
			{ text: "检索时间", label: "检索时间列" },
			{ text: "状态", label: "搜索状态列" },
		]);
	}
	if (view.label === "复测报告") {
		await clickText("交付");
		await waitFor(`Boolean(document.querySelector(".ant-dropdown"))`, "delivery menu");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await screenshot("14-report-delivery", [
			{ text: "生成 PDF + Word", label: "生成文档" },
			{ text: "创建分享链接", label: "创建分享链接" },
		]);
		await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
	}
	if (view.label === "优化文章") {
		await clickText("编辑", "button");
		await waitFor(`Boolean(document.querySelector(".ant-drawer"))`, "article editor");
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
		await screenshot("16-article-editor", [
			{ text: "编辑", label: "编辑模式" },
			{ text: "预览", label: "预览模式" },
			{ text: "保存", label: "保存文章" },
			{ text: "发布地址", label: "发布地址" },
		]);
		await evaluate(`document.querySelector(".ant-drawer-close")?.click(); true`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	if (view.label === "权限配置") {
		await clickText("角色权限", "[role=tab]");
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		await screenshot("23-rbac-roles", [
			{ text: "新建角色", label: "新建角色" },
			{ text: "保存角色", label: "保存角色" },
			{ text: "全选", label: "全选角色权限" },
			{ text: "清空", label: "清空角色权限" },
		]);
		await clickText("用户与客户范围", "[role=tab]");
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		await screenshot("24-rbac-users", [
			{ text: "用户与客户范围", label: "当前分区" },
			{ text: "全部客户", label: "授予全部客户" },
			{ text: "保存用户权限", label: "保存用户权限" },
		]);
	}
}

console.log("Help screenshots captured successfully.");
