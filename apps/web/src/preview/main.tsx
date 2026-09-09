import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../theme";
import "../styles.css";
import { ProductPreview } from "./ProductPreview";
import "./preview.css";

const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing");
createRoot(root).render(
	<StrictMode>
		<ThemeProvider>
			<ProductPreview />
		</ThemeProvider>
	</StrictMode>,
);
