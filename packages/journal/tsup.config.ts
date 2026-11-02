import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/attest/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
