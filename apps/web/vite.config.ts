import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "")
  return {
    // Relative paths, so the built site works from any folder or gateway.
    base: "./",
    esbuild: { jsx: "automatic" },
    // Only these values reach the browser. Nothing else from .env does.
    define: {
      __ARKIV_ACCESS_KEY__: JSON.stringify(env.ARKIV_ACCESS_KEY ?? ""),
      __DEMO_URL__: JSON.stringify(env.DEMO_URL ?? "http://localhost:8787"),
      __VERIFIER_URL__: JSON.stringify(env.VERIFIER_URL ?? "http://localhost:8788"),
      __SWARM_GATEWAY__: JSON.stringify(env.SWARM_GATEWAY_URL || "https://api.gateway.ethswarm.org"),
    },
    server: { port: 5173, strictPort: true, fs: { allow: ["../.."] } },
    build: { target: "esnext", chunkSizeWarningLimit: 4000 },
  }
})
