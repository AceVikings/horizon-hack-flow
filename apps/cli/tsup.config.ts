import { defineConfig } from "tsup";

// bundle: false keeps one output file per source file so the registry can load dist/commands/<lane>/*.js.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm"],
  bundle: false,
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
});
