export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...options,
			credentials: "same-origin",
			headers: { "content-type": "application/json", ...options.headers },
		});
	} catch {
		throw new ApiError("无法连接服务器，请检查网络后重试", 0);
	}
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new ApiError(body.error ?? `请求失败（HTTP ${response.status}）`, response.status);
	return body as T;
}

export const post = <T>(path: string, body: unknown = {}) =>
	api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
