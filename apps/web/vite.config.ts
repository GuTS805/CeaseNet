import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "")
  return {
    esbuild: { jsx: "automatic" },
    // Only these values reach the browser. Nothing else from .env does.
    define: {
      __ARKIV_ACCESS_KEY__: JSON.stringify(env.ARKIV_ACCESS_KEY ?? ""),
      __DEMO_URL__: JSON.stringify(env.DEMO_URL ?? "http://localhost:8787"),
    },
    server: { port: 5173, strictPort: true, fs: { allow: ["../.."] } },
    build: { target: "esnext", chunkSizeWarningLimit: 4000 },
  }
})
