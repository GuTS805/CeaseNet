import { defineConfig } from "vite"

// Motion marks its modules "use client" for server rendering. These apps render only in the browser, so the bundler
// dropping that line is expected, and the warning for each file would bury any real one.
const quietUseClient = (warning: { code?: string }, warn: (w: never) => void) => {
  if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning as never)
}

export default defineConfig({
  // Served by the program itself, from wherever it is installed.
  base: "./",
  esbuild: { jsx: "automatic" },
  build: { target: "esnext", assetsInlineLimit: 0, rollupOptions: { onwarn: quietUseClient } },
})
