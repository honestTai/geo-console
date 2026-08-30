import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api": "http://127.0.0.1:3010",
			"/artifacts": "http://127.0.0.1:3010",
			"/collector": {
				target: "http://127.0.0.1:3020",
				rewrite: (path) => path.replace(/^\/collector/, ""),
			},
		},
	},
});
