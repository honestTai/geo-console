import { IconArrowUpRight, IconChartBar, IconDatabase, IconFileText, IconSparkles } from "@tabler/icons-react";
import type { View } from "../types";
import { useWorkspaceNavigation } from "../ui/navigation";

const resources: Array<{ view: View; label: string; detail: string; icon: typeof IconChartBar }> = [
	{ view: "monitor", label: "监测指标", detail: "查看平台表现与变化", icon: IconChartBar },
	{ view: "evidence", label: "证据中心", detail: "回到原始回答与来源", icon: IconDatabase },
	{ view: "report", label: "报告与成果", detail: "查看已生成的交付内容", icon: IconFileText },
];

export function AgentResourceLinks({ compact = false }: { compact?: boolean }) {
	const navigation = useWorkspaceNavigation();
	const available = resources.filter((item) => navigation.panelViews.some((view) => view.id === item.view));
	if (!available.length) return null;
	return (
		<nav className={`agent-resources${compact ? " compact" : ""}`} aria-label="独立业务视图">
			{available.map(({ view, label, detail, icon: Icon }) => (
				<button key={view} type="button" onClick={() => navigation.openView(view)}>
					<span className="agent-resource-icon">
						<Icon size={18} stroke={1.6} />
					</span>
					<span>
						<strong>{label}</strong>
						{!compact && <small>{detail}</small>}
					</span>
					<IconArrowUpRight className="agent-resource-arrow" size={15} />
				</button>
			))}
		</nav>
	);
}

export function AgentWorkspaceIntro({ customer }: { customer: string }) {
	return (
		<div className="agent-intro">
			<span className="agent-intro-symbol" aria-hidden="true">
				<IconSparkles size={30} stroke={1.25} />
			</span>
			<span className="agent-intro-eyebrow">YOUR GEO WORKSPACE</span>
			<h2>从一个目标，开始这次工作。</h2>
			<p>
				围绕 <strong>{customer}</strong> 研究、监测与创作。
				<br />
				交代你想完成的事，过程与证据都会留在这里。
			</p>
		</div>
	);
}
