import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Static landing page. Brand SVGs are referenced straight from packages/ui/brand (single source, nothing copied);
// assetsInlineLimit 0 keeps them as hashed files instead of data URLs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { target: "es2020", assetsInlineLimit: 0 },
});
