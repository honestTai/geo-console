import { describe, expect, it } from "vitest";
import { classifySessionText } from "./status";

describe("classifySessionText", () => {
	it("优先识别安全验证", () => expect(classifySessionText("请完成滑块验证码", true)).toBe("challenge_required"));
	it("不会把短信登录验证码误判成安全挑战", () =>
		expect(classifySessionText("微信扫码登录 手机号登录 验证码", true)).toBe("login_required"));
	it("孤立验证码仍判定为安全挑战", () => expect(classifySessionText("验证码", true)).toBe("challenge_required"));
	it("有输入框时判定会话可用", () => expect(classifySessionText("欢迎", true)).toBe("ready"));
	it("无输入框时要求登录", () => expect(classifySessionText("扫码登录", false)).toBe("login_required"));
});
