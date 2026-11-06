import { gzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { fetchNpmPackage, measureFiles, parseSpec, parseTar } from "../src"

const utf8 = (s: string) => new TextEncoder().encode(s)

/** Builds one tar entry the way npm's own tools do. */
function entry(name: string, body: string, type = "0", prefix = ""): Uint8Array {
  const content = utf8(body)
  const header = new Uint8Array(512)
  header.set(utf8(name), 0)
  header.set(utf8(`${content.length.toString(8).padStart(11, "0")}\0`), 124)
  header.set(utf8(type), 156)
  header.set(utf8(prefix), 345)
  const padded = new Uint8Array(Math.ceil(content.length / 512) * 512)
  padded.set(content)
  const out = new Uint8Array(512 + padded.length)
  out.set(header)
  out.set(padded, 512)
  return out
}

const tar = (...parts: Uint8Array[]) => {
  const size = parts.reduce((n, p) => n + p.length, 0) + 1024
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const paths = (bytes: Uint8Array) => parseTar(bytes).map((f) => f.path)
const pax = (path: string) => {
  const line = (size: number) => `${size} path=${path}\n`
  let size = line(0).length
  while (line(size).length !== size) size = line(size).length
  return line(size)
}

describe("reading a package name", () => {
  it("understands plain and scoped names, with or without a version", () => {
    expect(parseSpec("left-pad")).toEqual({ name: "left-pad" })
    expect(parseSpec("left-pad@1.3.0")).toEqual({ name: "left-pad", version: "1.3.0" })
    expect(parseSpec("@scope/tool")).toEqual({ name: "@scope/tool" })
    expect(parseSpec("@scope/tool@2.0.0")).toEqual({ name: "@scope/tool", version: "2.0.0" })
  })

  it("refuses things that are not package names", () => {
    for (const bad of ["", "../evil", "a b", "tool@", "@scope", "http://x/y", "tool@1.0.0&calc", "tool@1 || x"]) expect(() => parseSpec(bad)).toThrow(/not a package name/)
  })
})

describe("unpacking a package", () => {
  it("drops the top folder, as npm does when installing", () => {
    const files = parseTar(tar(entry("package/package.json", "{}"), entry("package/lib/a.js", "a")))
    expect(files.map((f) => f.path)).toEqual(["package.json", "lib/a.js"])
    expect(new TextDecoder().decode(files[1]!.content)).toBe("a")
  })

  it("keeps content the same across the 512-byte blocks", () => {
    const long = "x".repeat(1300)
    const files = parseTar(tar(entry("package/big.js", long), entry("package/next.js", "n")))
    expect(new TextDecoder().decode(files[0]!.content)).toBe(long)
    expect(files[1]!.path).toBe("next.js")
  })

  it("skips folders and links", () => {
    expect(paths(tar(entry("package/lib/", "", "5"), entry("package/link", "", "2"), entry("package/a.js", "a")))).toEqual(["a.js"])
  })

  it("reads the three ways long names are stored", () => {
    const deep = `package/${"d/".repeat(70)}f.js`
    expect(paths(tar(entry("x", pax(deep), "x"), entry("package/short", "1")))[0]).toBe(deep.slice("package/".length))
    expect(paths(tar(entry("././@LongLink", deep, "L"), entry("package/short", "1")))[0]).toBe(deep.slice("package/".length))
    expect(paths(tar(entry("f.js", "1", "0", "package/lib")))[0]).toBe("lib/f.js")
  })

  it("refuses a path that could climb out of the package", () => {
    expect(() => parseTar(tar(entry("package/../../evil.js", "x")))).toThrow(/unsafe file path/)
  })

  it("measures the same whichever order the archive lists its files", () => {
    const a = parseTar(tar(entry("package/a.js", "a"), entry("package/b.js", "b")))
    const b = parseTar(tar(entry("package/b.js", "b"), entry("package/a.js", "a")))
    expect(measureFiles(a)).toBe(measureFiles(b))
  })
})

describe("fetching from npm", () => {
  const archive = gzipSync(tar(entry("package/package.json", JSON.stringify({ name: "tool", version: "1.0.0" })), entry("package/server.js", "run")))
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`
  const registry =
    (over: { integrity?: string; status?: number } = {}): typeof fetch =>
    async (input) => {
      const url = String(input)
      if (url.endsWith(".tgz")) return new Response(archive)
      if (over.status) return new Response("{}", { status: over.status })
      return Response.json({ name: "tool", bin: { tool: "server.js" }, dist: { tarball: "https://x/tool.tgz", integrity: over.integrity ?? integrity } })
    }

  it("measures what is inside, and reports the programs it provides", async () => {
    const pkg = await fetchNpmPackage({ name: "tool", version: "1.0.0" }, registry())
    expect(pkg.file).toMatchObject({ name: "tool", version: "1.0.0", kind: "tool" })
    expect(pkg.file.hash).toBe(measureFiles(pkg.files))
    expect(pkg.bin).toEqual({ tool: "server.js" })
  })

  it("refuses a download that does not match what npm published", async () => {
    await expect(fetchNpmPackage({ name: "tool" }, registry({ integrity: "sha512-AAAA" }))).rejects.toThrow(/does not match/)
  })

  it("says so plainly when the package does not exist", async () => {
    await expect(fetchNpmPackage({ name: "tool", version: "9.9.9" }, registry({ status: 404 }))).rejects.toThrow("npm has no package tool@9.9.9")
  })

  it("asks for the scoped name in the form npm expects", async () => {
    const seen: string[] = []
    await fetchNpmPackage({ name: "@scope/tool", version: "1.0.0" }, async (input, init) => {
      seen.push(String(input))
      return registry()(input, init)
    })
    expect(seen[0]).toBe("https://registry.npmjs.org/@scope%2ftool/1.0.0")
  })
})
