import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/app/",
	plugins: [react()],
	server: {
		proxy: {
			"/api": "http://127.0.0.1:3010",
			"/artifacts": "http://127.0.0.1:3010",
			"/share": "http://127.0.0.1:3010",
		},
	},
});
