import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
export const publicationPlanSchema = z.object({
	purpose: text,
	audience: text,
	problem: text,
	// 历史发布计划不补造写作方案；新生成草稿在 Agent 提交边界强制填写。
	contentStrategy: z
		.object({
			format: text,
			rationale: text,
			lengthApproach: text,
		})
		.optional(),
	channels: z
		.array(
			z
				.object({
					platform: text,
					placement: text,
					reason: text,
					adaptation: text,
					prerequisite: text,
					basis: z.enum(["owned", "observed_source", "candidate"]),
					evidenceIds: z.array(z.string()).max(30).default([]),
				})
				.superRefine((channel, context) => {
					if (channel.basis === "observed_source" && !channel.evidenceIds.length)
						context.addIssue({
							code: "custom",
							path: ["evidenceIds"],
							message: "声称证据中出现的渠道必须绑定来源证据",
						});
				}),
		)
		.min(1)
		.max(6),
	acceptance: z.array(text).min(1).max(10),
});
export type PublicationPlan = z.infer<typeof publicationPlanSchema>;
