import { LogServiceUnavailableError } from "@geo/logging";
import { z } from "zod";
import { AuthenticationError } from "./auth";
import { DesktopAgentConflictError } from "./desktop-agent";
import { HttpInputError } from "./utils";

/** Only deliberate domain errors may expose their messages. SQL, stack traces and upstream internals stay in logs. */
export function apiErrorResponse(
	error: unknown,
	requestId: string,
): { status: number; body: { error: string; requestId: string } } {
	let status = 500,
		message = "服务暂时无法完成请求，请使用请求编号联系管理员";
	if (error instanceof HttpInputError) {
		status = error.status;
		message = status < 500 ? error.message : "服务暂时不可用，请稍后重试";
	} else if (error instanceof AuthenticationError) {
		status = 401;
		message = error.message;
	} else if (error instanceof DesktopAgentConflictError) {
		status = 409;
		message = error.message;
	} else if (error instanceof LogServiceUnavailableError) {
		status = 503;
		message = "运行日志服务暂时不可用，请稍后重试";
	} else if (error instanceof z.ZodError) {
		status = 400;
		const labels: Record<string, string> = {
			too_small: "值过小或内容过短",
			too_big: "值过大或内容过长",
			invalid_type: "类型不正确",
			invalid_format: "格式不正确",
			invalid_value: "不受支持的取值",
			unrecognized_keys: "包含不支持的字段",
		};
		message =
			"参数校验失败：" +
			error.issues
				.slice(0, 5)
				.map(
					(issue) =>
						`${issue.path.join(".") || "请求"}：${labels[issue.code] ?? (issue.code === "custom" ? issue.message : "格式不符合要求")}`,
				)
				.join("；");
	}
	return { status, body: { error: message, requestId } };
}
