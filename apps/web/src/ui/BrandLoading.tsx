import type { CSSProperties } from "react";
import "./BrandLoading.css";

type MarkProps = {
	className?: string;
	style?: CSSProperties;
	inline?: boolean;
	percent?: number;
};

/** Spin clones its indicator with className, style and percent; only presentation props reach the DOM. */
export function BrandLoadingMark({ className, style, inline = false }: MarkProps) {
	return (
		<span
			className={["zz-loading-mark", inline && "zz-loading-mark-inline", className].filter(Boolean).join(" ")}
			style={style}
			aria-hidden="true"
		>
			<svg viewBox="0 0 40 40" fill="none" focusable="false" aria-hidden="true">
				<path className="zz-loading-track" d="M12 12H28L12 28H28" />
				<path className="zz-loading-trace" d="M12 12H28L12 28H28" pathLength="1" />
			</svg>
		</span>
	);
}

export function BrandLoading({ label = "正在加载", compact = false }: { label?: string; compact?: boolean }) {
	return (
		<div className={`zz-loading${compact ? " zz-loading-compact" : ""}`} role="status" aria-live="polite">
			<span className="zz-loading-accessible">{label}</span>
			<span className="zz-loading-lockup" aria-hidden="true">
				<BrandLoadingMark />
				<span className="zz-loading-identity">
					<span className="zz-loading-name">
						ZZ <b>GEO</b>
					</span>
					<span className="zz-loading-signal">
						<span />
					</span>
				</span>
			</span>
		</div>
	);
}
