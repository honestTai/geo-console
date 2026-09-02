import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import type { ReactNode } from "react";

dayjs.locale("zh-cn");

/** 与 styles.css :root 保持一致的品牌与中性色。 */
export const brandColor = "#16a34a";
export const inkColor = "#101828";
export const lineColor = "#e4e7ec";
export const sidebarColor = "#101828";

export function ThemeProvider({ children }: { children: ReactNode }) {
	return (
		<ConfigProvider
			locale={zhCN}
			theme={{
				token: {
					colorPrimary: brandColor,
					colorLink: "#15803d",
					colorLinkHover: brandColor,
					colorText: inkColor,
					colorTextSecondary: "#475467",
					colorTextTertiary: "#667085",
					colorBorder: lineColor,
					colorBorderSecondary: "#eef0f3",
					colorBgLayout: "#f6f7f9",
					borderRadius: 6,
					borderRadiusLG: 10,
					borderRadiusSM: 4,
					controlHeight: 36,
					controlHeightSM: 28,
					controlHeightLG: 42,
					fontSize: 14,
					fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif",
					boxShadowSecondary: "0 8px 24px rgba(16, 24, 40, 0.10)",
				},
				components: {
					Layout: { headerBg: sidebarColor, siderBg: sidebarColor, bodyBg: "#f6f7f9" },
					Button: {
						fontWeight: 600,
						paddingInline: 14,
						defaultBorderColor: "#c9cfd8",
						defaultShadow: "none",
						primaryShadow: "none",
					},
					Card: { paddingLG: 20, headerFontSize: 15, headerHeight: 52 },
					Table: {
						headerBg: "#f8f9fb",
						headerColor: "#475467",
						cellPaddingBlock: 12,
						cellPaddingInline: 14,
						rowHoverBg: "#f8f9fb",
					},
					Form: { itemMarginBottom: 16, labelColor: "#475467", labelFontSize: 13 },
					Input: { paddingInline: 12 },
					Select: { optionSelectedBg: "#ecfdf3" },
					Tag: { defaultBg: "#f2f4f7", defaultColor: "#475467" },
					Tabs: { titleFontSize: 14, horizontalItemPadding: "10px 0", horizontalMargin: "0 0 20px 0" },
					Modal: { titleFontSize: 16 },
					Drawer: { paddingLG: 20 },
					Statistic: { titleFontSize: 12.5, contentFontSize: 26 },
					Descriptions: { labelBg: "#f8f9fb" },
					Timeline: { dotBorderWidth: 2 },
					Steps: { iconSize: 26 },
					Alert: { defaultPadding: "10px 14px" },
				},
			}}
		>
			<AntdApp>{children}</AntdApp>
		</ConfigProvider>
	);
}
