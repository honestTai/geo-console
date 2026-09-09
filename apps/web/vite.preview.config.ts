import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/interactive/",
	plugins: [react()],
	build: {
		outDir: "../../landing/interactive",
		emptyOutDir: true,
		rolldownOptions: { input: "preview.html" },
	},
});
