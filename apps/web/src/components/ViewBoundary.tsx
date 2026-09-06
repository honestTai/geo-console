import { Component, type ReactNode, Suspense } from "react";
import { Button } from "../access";
import "./ViewBoundary.css";

/** An unavailable lazy chunk must not blank the entire console or trigger an automatic reload loop. */
export class ViewBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
		if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
	}
	render() {
		if (this.state.failed)
			return (
				<section className="view-load-state" role="alert">
					<h2>此功能暂时无法加载</h2>
					<p>可能是网络中断、页面异常或刚刚发布了新版本。可以切换其他功能，或刷新后重试。</p>
					<Button onClick={() => window.location.reload()}>刷新并重试</Button>
				</section>
			);
		return (
			<Suspense
				fallback={
					<div className="view-load-state" role="status" aria-live="polite">
						正在加载功能…
					</div>
				}
			>
				{this.props.children}
			</Suspense>
		);
	}
}
