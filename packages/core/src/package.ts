import { base64ToBytes, bytesToBase64 } from "./base64"
import { hashBytes } from "./hash"
import type { Hex, LoadedFile } from "./types"

/** One file of a package, by its path inside the package. */
export interface PackageFile {
  path: string
  content: Uint8Array
}

const FORMAT = "ceasenet.package/1"
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024

/**
 * Hashes what a package really contains, not what it says about itself.
 * Each file counts by its path and content, in a fixed order, so the same package always gives the same hash.
 */
export function measureFiles(files: readonly PackageFile[]): Hex {
  return hashBytes(
    files
      .map((f) => `${f.path}\0${hashBytes(f.content)}`)
      .sort()
      .join("\n"),
  )
}

/** One file holding a whole package, so a package can be fetched from a single link. */
export function encodeBundle(files: readonly PackageFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1))
  return new TextEncoder().encode(
    JSON.stringify({ format: FORMAT, files: sorted.map((f) => ({ path: f.path, base64: bytesToBase64(f.content) })) }),
  )
}

/** A path inside a package. Anything that could climb out of the folder it is unpacked into is refused. */
function safePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) throw new Error("the package has an unusable file path")
  const unsafe = path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("\0")
  if (unsafe || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`the package has an unsafe file path: ${path.slice(0, 80)}`)
  }
  return path
}

export function decodeBundle(bytes: Uint8Array): PackageFile[] {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("the package is too large")
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown; files?: unknown }
  if (parsed.format !== FORMAT || !Array.isArray(parsed.files)) throw new Error("this is not a CeaseNet package")
  const seen = new Set<string>()
  return parsed.files.map((entry: { path?: unknown; base64?: unknown }) => {
    const path = safePath(entry?.path)
    if (seen.has(path)) throw new Error(`the package lists ${path.slice(0, 80)} twice`)
    seen.add(path)
    if (typeof entry.base64 !== "string") throw new Error("the package has an unreadable file")
    return { path, content: base64ToBytes(entry.base64) }
  })
}

/** What a package says it is, with the hash of what it really contains. */
export function describePackage(files: readonly PackageFile[], kind = "tool"): LoadedFile {
  const manifest = files.find((f) => f.path === "package.json")
  if (!manifest) throw new Error("the package has no package.json")
  const { name, version } = JSON.parse(new TextDecoder().decode(manifest.content)) as { name?: string; version?: string }
  if (!name || !version) throw new Error("the package has no name and version")
  return { kind, name, version, hash: measureFiles(files) }
}
