export function classifySessionText(
	body: string,
	hasComposer: boolean,
): "ready" | "login_required" | "challenge_required" {
	if (/安全验证|访问过于频繁|verify you are human|captcha|请完成(?:图片|滑块|安全)?验证码/i.test(body))
		return "challenge_required";
	// Login dialogs can sit above a visible composer and include an SMS "验证码" field.
	if (/微信扫码登录|手机号登录|扫码登录|登录以同步|请先登录|注册(?:并)?登录|sign in|log in/i.test(body))
		return "login_required";
	if (/验证码/i.test(body)) return "challenge_required";
	if (hasComposer) return "ready";
	return "login_required";
}
