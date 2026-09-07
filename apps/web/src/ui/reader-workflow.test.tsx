import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeasurementExplanation } from "../components/MeasurementExplanation";
import { PublicationPlanView } from "../components/PublicationPlan";
import { MetricLabel } from "./MetricLabel";
import { EvidenceRef } from "./primitives";

describe("plain-language measurement and article UI", () => {
	it("makes metrics and even unresolved evidence references keyboard-clickable", () => {
		const metric = renderToStaticMarkup(<MetricLabel metric="brandMentionRate" />);
		expect(metric).toContain("了解品牌提及率的含义与计算方法");
		expect(metric).toContain("<button");
		expect(renderToStaticMarkup(<EvidenceRef ids={["missing"]} index={[]} />)).toContain("<button");
	});
	it("does not turn pending analysis into scores and labels missing legacy article plans", () => {
		const html = renderToStaticMarkup(<MeasurementExplanation batchId="test" />);
		expect(html).toContain("尚未生成可靠的指标说明");
		expect(html).not.toContain("0%");
		expect(renderToStaticMarkup(<PublicationPlanView plan={null} />)).toContain("历史文章没有保存用途与发布计划");
		expect(renderToStaticMarkup(<PublicationPlanView plan={{ purpose: "尚在编辑的测试计划" }} />)).toContain(
			"尚未填写建议发布位置",
		);
	});
	it("explains the evidence-led writing format without inventing a strategy for legacy articles", () => {
		const html = renderToStaticMarkup(
			<PublicationPlanView
				plan={{
					purpose: "回答实际问题",
					contentStrategy: {
						format: "单条短答",
						rationale: "此问题不需要扩展为长文",
						lengthApproach: "说明已知事实即可，不凑字数",
					},
				}}
			/>,
		);
		expect(html).toContain("为什么这样写");
		expect(html).toContain("单条短答");
		expect(html).toContain("不凑字数");
		expect(renderToStaticMarkup(<PublicationPlanView plan={{ purpose: "历史计划" }} />)).toContain(
			"尚未记录内容形式与篇幅依据",
		);
	});
});
