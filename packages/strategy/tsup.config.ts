import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/replay/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
