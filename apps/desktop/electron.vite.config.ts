import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath, URL } from "node:url";

const alias = {
  "@hynite/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
  "@hynite/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
  "@hynite/importers": fileURLToPath(new URL("../../packages/importers/src/index.ts", import.meta.url)),
  "@hynite/metadata": fileURLToPath(new URL("../../packages/metadata/src/index.ts", import.meta.url)),
  "@hynite/recommendations": fileURLToPath(new URL("../../packages/recommendations/src/index.ts", import.meta.url)),
  "@hynite/source-search": fileURLToPath(new URL("../../packages/source-search/src/index.ts", import.meta.url))
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      lib: {
        entry: fileURLToPath(new URL("src/main/index.ts", import.meta.url))
      },
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      lib: {
        entry: fileURLToPath(new URL("src/preload/index.ts", import.meta.url))
      },
      rollupOptions: {
        output: {
          format: "cjs"
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: fileURLToPath(new URL(".", import.meta.url)),
    publicDir: fileURLToPath(new URL("../../assets/icons", import.meta.url)),
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("index.html", import.meta.url)),
          splash: fileURLToPath(new URL("splash.html", import.meta.url)),
          spotlight: fileURLToPath(new URL("spotlight.html", import.meta.url))
        }
      }
    }
  }
});
