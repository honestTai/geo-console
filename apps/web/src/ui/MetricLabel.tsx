import { guideForLabel, type MetricGuideKey, metricGuide } from "@geo/metrics";
import { Popover } from "antd";

export function MetricLabel({
	label,
	metric,
	help,
}: {
	label?: string;
	metric?: MetricGuideKey;
	help?: { label: string; meaning: string; formula: string; caution: string };
}) {
	const guide = help ?? (metric ? metricGuide[metric] : guideForLabel(label ?? ""));
	const text = label ?? guide?.label ?? "指标";
	if (!guide) return <span>{text}</span>;
	return (
		<Popover
			trigger={["hover", "click", "focus"]}
			title={guide.label}
			content={
				<div style={{ maxWidth: 380 }}>
					<p>{guide.meaning}</p>
					<p>
						<b>计算方法：</b>
						{guide.formula}
					</p>
					<p>{guide.caution}</p>
					{!help && <small>多个问题、多个平台按等权汇总，详细分母请看“数字怎么算”。</small>}
				</div>
			}
		>
			<button type="button" className="metric-help-button" aria-label={`了解${text}的含义与计算方法`}>
				{text} <span aria-hidden="true">ⓘ</span>
			</button>
		</Popover>
	);
}
