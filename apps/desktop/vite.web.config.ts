// Web build of the renderer for Flow cloud (apps/cloud serves out/web): same views, web bridge instead of preload.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "/",
  plugins: [react()],
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  build: { outDir: resolve(__dirname, "out/web"), emptyOutDir: true, rollupOptions: { input: resolve(__dirname, "src/renderer/web.html") } },
});
