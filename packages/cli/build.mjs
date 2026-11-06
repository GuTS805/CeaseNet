// Builds the one file that gets installed, with the console's pages beside it.
import { execSync } from "node:child_process"
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, "dist")
const root = join(here, "..", "..")

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [join(here, "src", "main.ts")],
  outdir: dist,
  entryNames: "ceasenet",
  chunkNames: "chunk-[hash]",
  outExtension: { ".js": ".mjs" },
  // The hook runs before every tool call, so what only the console needs is loaded only by the console.
  splitting: true,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  // So the console can tell it is older than the program that just started.
  define: { __CEASENET_BUILD__: JSON.stringify(String(Date.now())) },
  logLevel: "warning",
  // Libraries written for CommonJS expect these, and a bundle in ESM does not have them.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __toPath } from "node:url";',
      'import { dirname as __dirname_ } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __toPath(import.meta.url);",
      "const __dirname = __dirname_(__filename);",
    ].join("\n"),
  },
})

// The agents' tools go beside the program, each with its own package.json, so each is measured as a package of its own.
for (const tool of ["trade-market-tool-1.0.0", "trade-broker-tool-1.0.0"]) {
  const out = join(dist, "tools", tool)
  await build({
    entryPoints: [join(root, "tools", tool, "server.mjs")],
    outfile: join(out, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
  })
  copyFileSync(join(root, "tools", tool, "package.json"), join(out, "package.json"))
}

execSync("npm run build -w @ceasenet/console", { cwd: root, stdio: "inherit" })
const pages = join(root, "apps", "console", "dist")
if (!existsSync(join(pages, "index.html"))) throw new Error("the console did not build")
cpSync(pages, join(dist, "console"), { recursive: true })
cpSync(join(root, "LICENSE"), join(here, "LICENSE"))
console.log(`built ${join(dist, "ceasenet.mjs")}`)
