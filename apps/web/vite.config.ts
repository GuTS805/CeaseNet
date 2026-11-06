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
      // Only the scripted demo has agents behind the site. It is asked for with: npm run web:demo
      __DEMO_URL__: JSON.stringify(env.DEMO_URL ?? (mode === "demo" ? "http://localhost:8787" : "")),
      // A hosted site is told where its verifier is. While developing, it is the one started by npm run verifier.
      __VERIFIER_URL__: JSON.stringify(env.VERIFIER_URL ?? (mode === "production" ? "" : "http://localhost:8788")),
      __SWARM_GATEWAY__: JSON.stringify(env.SWARM_GATEWAY_URL || "https://api.gateway.ethswarm.org"),
    },
    server: { port: 5173, strictPort: true, fs: { allow: ["../.."] } },
    build: { target: "esnext", chunkSizeWarningLimit: 4000 },
  }
})
