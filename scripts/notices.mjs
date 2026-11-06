// Writes THIRD_PARTY_NOTICES.md: every package CeaseNet ships or runs on, with its version and licence, read from
// node_modules. Run it after changing dependencies. CI runs it too, and fails if the file is out of date.
//
//   node scripts/notices.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path) => JSON.parse(readFileSync(path, "utf8"))

/** Finds a dependency the way Node does: the nearest node_modules up from the package that needs it. */
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json")
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

function licenceOf(pkg, path) {
  const stated = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR "))
  if (stated) return stated
  // Some packages state their licence only in a file.
  const file = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => join(dirname(path), f)).find(existsSync)
  const first = file ? readFileSync(file, "utf8").trim().split(/\r?\n/)[0] : ""
  return /^MIT License/i.test(first) ? "MIT (LICENSE file)" : first ? "See its LICENSE file" : "Not stated"
}

const found = new Map()
function walk(name, fromDir) {
  const path = locate(name, fromDir)
  if (!path) return
  const pkg = read(path)
  const id = `${pkg.name}@${pkg.version}`
  if (found.has(id)) return
  const repo = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "")
  found.set(id, {
    name: pkg.name,
    version: pkg.version,
    licence: licenceOf(pkg, path),
    source: repo.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/^github:/, "https://github.com/"),
  })
  // Optional dependencies are left out: they differ between operating systems, such as a build tool's own binary.
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dirname(path))
}

/**
 * Starts from each of our own packages. The program lists what it bundles as development dependencies, so those count
 * for it. For the others, development dependencies are tools that never ship.
 */
const ours = ["packages", "apps"].flatMap((group) => readdirSync(join(root, group)).map((name) => join(root, group, name))).filter((dir) => existsSync(join(dir, "package.json")))
for (const dir of ours) {
  const pkg = read(join(dir, "package.json"))
  const roots = { ...pkg.dependencies, ...(pkg.name === "ceasenet" ? pkg.devDependencies : {}) }
  for (const dep of Object.keys(roots)) if (!dep.startsWith("@ceasenet/") && dep !== "ceasenet" && dep !== "esbuild") walk(dep, dir)
}

const rows = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const counts = {}
for (const r of rows) counts[r.licence] = (counts[r.licence] ?? 0) + 1
const byCount = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
const text = `# Third-party notices

CeaseNet is MIT licensed ([LICENSE](LICENSE)). The program, the site and the verifier include or depend on the open-source packages below, each under its own licence. This file is generated from \`node_modules\` by [scripts/notices.mjs](scripts/notices.mjs), and CI fails if it falls out of date. It leaves out tools used only to build and test.

Licences: ${byCount.map(([l, n]) => `${l} (${n})`).join(", ")}.

| Package | Version | Licence | Source |
| --- | --- | --- | --- |
${rows.map((r) => `| ${r.name} | ${r.version} | ${r.licence} | ${r.source} |`).join("\n")}
`
writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), text)
console.log(`THIRD_PARTY_NOTICES.md: ${rows.length} packages. ${byCount.map(([l, n]) => `${l} ${n}`).join(", ")}`)
