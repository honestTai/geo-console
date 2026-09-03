import type { Competitor, Project, Prompt } from "../types";

export const SCOPE_BUNDLE_KIND = "geo-project-scope";

export type ScopeBundle = {
	kind: typeof SCOPE_BUNDLE_KIND;
	version: 1;
	exportedAt: string;
	project: { name: string; domain: string };
	aliases: string[];
	competitors: Competitor[];
	/** 导出时知识库引用写成 `libraryQuestionId`（与确认接口一致），解析后回到 `library_question_id`。 */
	prompts: Array<Prompt & { libraryQuestionId?: string }>;
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const textList = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

/**
 * 把导出的范围包整理成编辑器可用的数据；只保留业务字段，丢掉属于原项目的行 id，
 * 知识库引用保留（同机构导入时继续挂在原问题上，跨机构或已归档的引用由服务端去掉并计数）。
 * 导入后仍要人工确认再保存为新范围版本。
 */
export function parseScopeBundle(
	bundle: Record<string, unknown>,
): Pick<ScopeBundle, "aliases" | "competitors" | "prompts"> {
	if (bundle.kind !== SCOPE_BUNDLE_KIND) throw new Error("文件不是本系统导出的监测范围包");
	const competitors = (Array.isArray(bundle.competitors) ? bundle.competitors : [])
		.map((item: unknown) => {
			const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			return { name: text(record.name), domain: text(record.domain), aliases: textList(record.aliases) };
		})
		.filter((item) => item.name && item.domain);
	const prompts = (Array.isArray(bundle.prompts) ? bundle.prompts : [])
		.map((item: unknown) => {
			const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
			return {
				library_question_id: text(record.libraryQuestionId) || null,
				question: text(record.question),
				intent: text(record.intent) || "购买决策",
				topic: text(record.topic) || null,
				persona: text(record.persona) || null,
				tags: textList(record.tags),
			};
		})
		.filter((item) => item.question.length >= 4);
	if (!prompts.length) throw new Error("范围包里没有可用的购买问题");
	return { aliases: textList(bundle.aliases), competitors, prompts };
}

export function buildScopeBundle(
	project: Pick<Project, "name" | "domain">,
	scope: { aliases: string[]; competitors: Competitor[]; prompts: Prompt[] },
	exportedAt = new Date().toISOString(),
): ScopeBundle {
	return {
		kind: SCOPE_BUNDLE_KIND,
		version: 1,
		exportedAt,
		project: { name: project.name, domain: project.domain },
		aliases: scope.aliases,
		competitors: scope.competitors.map(({ name, domain, aliases }) => ({ name, domain, aliases })),
		prompts: scope.prompts.map(({ question, intent, topic, persona, tags, library_question_id }) => ({
			...(library_question_id ? { libraryQuestionId: library_question_id } : {}),
			question,
			intent,
			topic: topic ?? null,
			persona: persona ?? null,
			tags,
		})),
	};
}
