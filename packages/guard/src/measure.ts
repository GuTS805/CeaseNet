import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { type Hex, type LoadedFile, measureFiles, type PackageFile } from "@ceasenet/core"

const SKIP = new Set(["node_modules", ".git"])

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !SKIP.has(name))
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
}

/** Reads a package from disk, with paths written the same way on every system. */
export const readPackage = (dir: string): PackageFile[] =>
  listFiles(dir).map((path) => ({ path: relative(dir, path).split(sep).join("/"), content: readFileSync(path) }))

/** Hashes what a package really contains, not what it says about itself. */
export const measureDir = (dir: string): Hex => measureFiles(readPackage(dir))

/** Measures an installed package. Its name and version come from its own package.json. */
export function measurePackage(dir: string, kind = "tool"): LoadedFile {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string }
  if (!manifest.name || !manifest.version) throw new Error(`${dir} has no name and version in its package.json`)
  return { kind, name: manifest.name, version: manifest.version, hash: measureDir(dir) }
}
