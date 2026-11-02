import { defineConfig } from "vite";

// Static landing page. Brand SVGs are referenced straight from packages/ui/brand (single source, nothing copied);
// assetsInlineLimit 0 keeps them as hashed files instead of data URLs.
export default defineConfig({
  build: { target: "es2020", assetsInlineLimit: 0 },
});
