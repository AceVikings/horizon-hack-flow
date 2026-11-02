import { defineConfig } from "tsup";

// Bundles the desktop's electron-free DaemonClient (apps/desktop/src/main/daemon.ts) and the shared bridge types.
export default defineConfig({ entry: ["src/bin.ts"], format: ["esm"], clean: true, sourcemap: true, target: "node22", noExternal: [/^\.\.?\//] });
