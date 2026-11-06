import { defineConfig } from "vite"

export default defineConfig({
  // Served by the program itself, from wherever it is installed.
  base: "./",
  esbuild: { jsx: "automatic" },
  build: { target: "esnext", assetsInlineLimit: 0 },
})
