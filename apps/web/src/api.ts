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
		const desktopClient = navigator.userAgent.includes("ZZGeoDesktop/");
		if (desktopClient) {
			const { invoke } = await import("@tauri-apps/api/core");
			options.signal?.throwIfAborted();
			const result = await invoke<{ status: number; body: unknown }>("desktop_api_request", {
				path,
				method: options.method ?? "GET",
				body: typeof options.body === "string" ? options.body : null,
			});
			options.signal?.throwIfAborted();
			response = new Response(JSON.stringify(result.body), {
				status: result.status,
				headers: { "content-type": "application/json" },
			});
		} else
			response = await fetch(path, {
				...options,
				credentials: "same-origin",
				headers: {
					"content-type": "application/json",
					...(desktopClient ? { "x-geo-client": "desktop" } : {}),
					...options.headers,
				},
			});
	} catch (error) {
		options.signal?.throwIfAborted();
		const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
		throw new ApiError(
			navigator.userAgent.includes("ZZGeoDesktop/") && detail ? detail : "无法连接服务器，请检查网络后重试",
			0,
		);
	}
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new ApiError(body.error ?? `请求失败（HTTP ${response.status}）`, response.status);
	return body as T;
}

export const post = <T>(path: string, body: unknown = {}) =>
	api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
