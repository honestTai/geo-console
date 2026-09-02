import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import type { ReactNode } from "react";

dayjs.locale("zh-cn");

export function ThemeProvider({ children }: { children: ReactNode }) {
	return (
		<ConfigProvider
			locale={zhCN}
			theme={{
				token: {
					colorPrimary: "#16a34a",
					borderRadius: 6,
					fontSize: 14,
					fontFamily: "Inter, PingFang SC, Microsoft YaHei, sans-serif",
				},
				components: {
					Layout: { headerBg: "#101828", siderBg: "#101828" },
				},
			}}
		>
			<AntdApp>{children}</AntdApp>
		</ConfigProvider>
	);
}
