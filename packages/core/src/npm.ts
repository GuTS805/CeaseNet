import { bytesToBase64 } from "./base64"
import { describePackage, type PackageFile, safePath } from "./package"
import type { LoadedFile } from "./types"

/**
 * Reads real packages from the npm registry, in a browser or in Node.
 *
 * A recall names a file's hash, so whoever issues one has to measure the exact thing people run. The result here
 * must match `measurePackage` on an installed copy, and a live check confirms it does.
 */

const REGISTRY = "https://registry.npmjs.org"
const MAX_TARBALL_BYTES = 50 * 1024 * 1024
const BLOCK = 512

export interface PackageSpec {
  name: string
  /** A version or a dist-tag. Missing means "latest". */
  version?: string
}

/** Reads `name`, `name@1.2.3`, `@scope/name` or `@scope/name@1.2.3`. */
export function parseSpec(spec: string): PackageSpec {
  const text = spec.trim()
  const at = text.lastIndexOf("@")
  const name = at > 0 ? text.slice(0, at) : text
  const version = at > 0 ? text.slice(at + 1) : undefined
  if (!/^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i.test(name) || version === "") throw new Error(`"${spec}" is not a package name`)
  return version ? { name, version } : { name }
}

export const specText = (spec: PackageSpec) => (spec.version ? `${spec.name}@${spec.version}` : spec.name)

const text = (block: Uint8Array, start: number, length: number) => {
  const part = block.subarray(start, start + length)
  const end = part.indexOf(0)
  return new TextDecoder().decode(end === -1 ? part : part.subarray(0, end))
}

const octal = (block: Uint8Array, start: number, length: number) => {
  // Very large sizes use a binary form that a package this small can never need.
  if ((block[start]! & 0x80) !== 0) throw new Error("the package has a file too large to read")
  const value = parseInt(text(block, start, length).trim() || "0", 8)
  if (Number.isNaN(value)) throw new Error("the package is not a readable archive")
  return value
}

/** The `path` entry of a long-name header, which looks like `30 path=some/long/name\n`. */
function paxPath(body: Uint8Array): string | undefined {
  const records = new TextDecoder().decode(body)
  let at = 0
  while (at < records.length) {
    const space = records.indexOf(" ", at)
    if (space === -1) return undefined
    const size = Number(records.slice(at, space))
    if (!Number.isInteger(size) || size <= 0) return undefined
    const record = records.slice(space + 1, at + size - 1)
    if (record.startsWith("path=")) return record.slice("path=".length)
    at += size
  }
  return undefined
}

/** Unpacks a tar archive in memory. Only regular files count, and each path loses its top folder, as npm does when installing. */
export function parseTar(archive: Uint8Array): PackageFile[] {
  const files = new Map<string, Uint8Array>()
  let longName: string | undefined
  let at = 0
  while (at + BLOCK <= archive.length) {
    const header = archive.subarray(at, at + BLOCK)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156]!)
    const body = archive.subarray(at + BLOCK, at + BLOCK + size)
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === "x") {
      longName = paxPath(body) ?? longName
      continue
    }
    if (type === "L") {
      longName = text(body, 0, body.length)
      continue
    }
    if (type === "g") continue
    const prefix = text(header, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
    longName = undefined
    if (type !== "0" && type !== "\0") continue
    const inner = name.split("/").slice(1).join("/")
    if (inner) files.set(safePath(inner), body.slice())
  }
  return [...files].map(([path, content]) => ({ path, content }))
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export interface NpmPackage {
  file: LoadedFile
  files: PackageFile[]
  tarball: string
  /** Program names the package provides, from its own package.json. */
  bin: Record<string, string>
}

/** Fetches one version of a package, checks it against the hash npm publishes for it, and measures what is inside. */
export async function fetchNpmPackage(spec: PackageSpec, fetchImpl: typeof fetch = fetch): Promise<NpmPackage> {
  const label = specText(spec)
  const meta = await fetchImpl(`${REGISTRY}/${spec.name.replace("/", "%2f")}/${encodeURIComponent(spec.version ?? "latest")}`)
  if (meta.status === 404) throw new Error(`npm has no package ${label}`)
  if (!meta.ok) throw new Error(`npm answered HTTP ${meta.status} for ${label}`)
  const info = (await meta.json()) as { dist?: { tarball?: string; integrity?: string }; bin?: string | Record<string, string>; name?: string }
  const tarball = info.dist?.tarball
  if (!tarball) throw new Error(`npm gave no download for ${label}`)

  const res = await fetchImpl(tarball)
  if (!res.ok) throw new Error(`npm answered HTTP ${res.status} for the ${label} download`)
  const compressed = new Uint8Array(await res.arrayBuffer())
  if (compressed.length > MAX_TARBALL_BYTES) throw new Error(`${label} is too large to measure here`)

  const integrity = info.dist?.integrity
  if (integrity?.startsWith("sha512-")) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", compressed as BufferSource))
    if (`sha512-${bytesToBase64(digest)}` !== integrity) throw new Error(`the download of ${label} does not match what npm published`)
  }

  const files = parseTar(await gunzip(compressed))
  const file = describePackage(files)
  const bin = typeof info.bin === "string" ? { [info.name?.split("/").pop() ?? spec.name]: info.bin } : (info.bin ?? {})
  return { file, files, tarball, bin }
}
