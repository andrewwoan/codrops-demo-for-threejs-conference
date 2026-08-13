import { defineConfig } from "vite";
import assetReloader from "./scripts/vite-plugin-asset-reloader.mjs";
import transformOverrides from "./scripts/vite-plugin-transform-overrides.mjs";

export default defineConfig({
  plugins: [assetReloader(), transformOverrides()],
});
