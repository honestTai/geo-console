import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.GEO_DEV_API_ORIGIN?.trim() || "http://127.0.0.1:3010";
export default defineConfig({
	base: "/app/",
	plugins: [react()],
	server: {
		proxy: {
			"/api": apiOrigin,
			"/artifacts": apiOrigin,
			"/share": apiOrigin,
		},
	},
});
