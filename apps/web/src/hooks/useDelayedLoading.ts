import { useEffect, useState } from "react";
import { LOADING_DELAY_MS } from "../components/Page";

/**
 * 防抖 loading：只有持续加载超过 delay 才返回 true，加载结束立即返回 false。
 * 用于列表/面板等不经过 Page 外壳的局部区域，避免快速请求造成闪烁。
 */
export function useDelayedLoading(loading: boolean, delay = LOADING_DELAY_MS): boolean {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!loading) {
			setVisible(false);
			return;
		}
		const timer = window.setTimeout(() => setVisible(true), delay);
		return () => window.clearTimeout(timer);
	}, [loading, delay]);
	return loading && visible;
}
