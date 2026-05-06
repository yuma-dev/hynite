import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: {
      "@hynite/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@hynite/db": fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)),
      "@hynite/importers": fileURLToPath(new URL("./packages/importers/src/index.ts", import.meta.url)),
      "@hynite/metadata": fileURLToPath(new URL("./packages/metadata/src/index.ts", import.meta.url)),
      "@hynite/recommendations": fileURLToPath(new URL("./packages/recommendations/src/index.ts", import.meta.url)),
      "@hynite/source-search": fileURLToPath(new URL("./packages/source-search/src/index.ts", import.meta.url))
    }
  }
});

