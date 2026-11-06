import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { hashBytes, type Hex, type LoadedFile } from "@ceasenet/core"

const SKIP = new Set(["node_modules", ".git"])

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !SKIP.has(name))
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
}

/**
 * Hashes what a package really contains, not what it says about itself.
 * Each file counts by its path and content, in a fixed order, so the same package always gives the same hash.
 */
export function measureDir(dir: string): Hex {
  const lines = listFiles(dir)
    .map((path) => `${relative(dir, path).split(sep).join("/")}\0${hashBytes(readFileSync(path))}`)
    .sort()
  return hashBytes(lines.join("\n"))
}

/** Measures an installed package. Its name and version come from its own package.json. */
export function measurePackage(dir: string, kind = "tool"): LoadedFile {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string }
  if (!manifest.name || !manifest.version) throw new Error(`${dir} has no name and version in its package.json`)
  return { kind, name: manifest.name, version: manifest.version, hash: measureDir(dir) }
}
