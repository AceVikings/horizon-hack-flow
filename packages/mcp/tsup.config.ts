import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/stub/main.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
  target: "node22",
});
