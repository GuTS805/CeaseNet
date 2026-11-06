import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fetchNpmPackage, type LoadedFile, type PackageSpec, specText } from "@ceasenet/core"
import { measurePackage } from "./measure"

export interface InstalledTool {
  file: LoadedFile
  dir: string
  bin: Record<string, string>
}

const EXACT_VERSION = /^\d+\.\d+\.\d+([-+][\w.+-]+)?$/

const toolDir = (home: string, name: string, version: string) => {
  const prefix = join(home, "tools", `${name.replace("/", "__")}@${version}`)
  return { prefix, dir: join(prefix, "node_modules", ...name.split("/")) }
}

/** Reads what a package says it can run. */
export function readBin(dir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; bin?: string | Record<string, string> }
  if (typeof manifest.bin === "string") return { [manifest.name?.split("/").pop() ?? "tool"]: manifest.bin }
  return manifest.bin ?? {}
}

/** Which program in a package to start. With several and no choice made, it asks rather than guessing. */
export function chooseBin(name: string, bin: Record<string, string>, wanted?: string): string {
  const names = Object.keys(bin)
  if (names.length === 0) throw new Error(`${name} has no program to run, so it cannot be started as a tool`)
  if (wanted) {
    if (!bin[wanted]) throw new Error(`${name} has no program called ${wanted}. It has: ${names.join(", ")}`)
    return bin[wanted]!
  }
  if (names.length === 1) return bin[names[0]!]!
  const own = name.split("/").pop()!
  if (bin[own]) return bin[own]!
  throw new Error(`${name} has several programs. Choose one with --bin: ${names.join(", ")}`)
}

/**
 * Installs one exact version into its own folder, with the package's install scripts turned off, and measures it.
 * What landed on disk must match what npm publishes for that version, or it is refused.
 * Progress goes to stderr, because stdout may be carrying the MCP protocol.
 */
export async function installTool(home: string, spec: PackageSpec): Promise<InstalledTool> {
  if (spec.version && EXACT_VERSION.test(spec.version)) {
    const { dir } = toolDir(home, spec.name, spec.version)
    // Already installed needs no network, so a tool keeps starting while npm is unreachable.
    if (existsSync(join(dir, "package.json"))) return { file: measurePackage(dir), dir, bin: readBin(dir) }
  }
  const published = await fetchNpmPackage(spec)
  const { version } = published.file
  const { prefix, dir } = toolDir(home, spec.name, version)
  if (!existsSync(join(dir, "package.json"))) {
    mkdirSync(prefix, { recursive: true })
    const windows = process.platform === "win32"
    // parseSpec has already checked the name and version, so the shell Windows needs here sees nothing unexpected.
    const result = spawnSync(
      windows ? "npm.cmd" : "npm",
      ["install", "--prefix", `"${prefix}"`, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error", `${spec.name}@${version}`],
      { stdio: ["ignore", 2, 2], shell: true },
    )
    if (result.status !== 0) throw new Error(`npm could not install ${specText(spec)}`)
  }
  const file = measurePackage(dir)
  if (file.hash.toLowerCase() !== published.file.hash.toLowerCase()) {
    throw new Error(`what npm installed for ${spec.name}@${version} does not match what it publishes, so it will not be run`)
  }
  return { file, dir, bin: readBin(dir) }
}
