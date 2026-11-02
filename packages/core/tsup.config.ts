import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/abi/policyVault.ts", "src/fixtures.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
