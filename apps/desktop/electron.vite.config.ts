import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ["@ate/core"] })] },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@ate/core"] })],
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { "@shared": resolve("src/shared") } },
  },
});
