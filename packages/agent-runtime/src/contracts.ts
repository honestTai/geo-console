/** Persisted GEO transcript v1. Kept stable so existing sessions remain readable after replacing Pi. */
export type TextContent = { type: "text"; text: string };
export type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type Usage = {
	input: number;
	output: number;
	totalTokens: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
export type AgentMessage =
	| { role: "user"; content: string | TextContent[]; timestamp: number }
	| {
			role: "assistant";
			content: Array<TextContent | ToolCall>;
			timestamp: number;
			usage: Usage;
			api?: string;
			provider?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: TextContent[];
			isError: boolean;
			timestamp: number;
			terminate?: boolean;
	  };
export type AgentToolResult<T = unknown> = { content: TextContent[]; details?: T; terminate?: boolean };
export type AgentTool = {
	name: string;
	label: string;
	description: string;
	parameters: object;
	executionMode?: "sequential" | "parallel";
	execute(
		id: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (result: AgentToolResult) => void,
	): Promise<AgentToolResult>;
};
export function contentText(content: string | Array<{ type: string; text?: string }>): string {
	return typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
}
export function pendingDesktopToolCalls(messages: AgentMessage[]): Omit<ToolCall, "type">[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const completed = new Set(
			messages.slice(index + 1).flatMap((item) => (item.role === "toolResult" ? [item.toolCallId] : [])),
		);
		return message.content
			.filter((part): part is ToolCall => part.type === "toolCall" && !completed.has(part.id))
			.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
	}
	return [];
}
