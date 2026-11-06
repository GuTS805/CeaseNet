import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assertPublicRef, decodeBundle, encodeBundle, hashBytes, isEncryptedSwarmRef, isPublicSwarmRef, measureFiles } from "@ceasenet/core"
import { privateKeyToAccount } from "viem/accounts"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { fetchPackage, measureDir, openSealedRef, readPackage, sealRef, SwarmClient } from "../src"

const BATCH = "a".repeat(64)
const stored = new Map<string, Uint8Array>()
const seen: { headers: Record<string, unknown>; url: string }[] = []

/** Follows Bee's published API for the two calls CeaseNet makes. */
const bee: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x")
  if (req.method === "POST" && url.pathname === "/bzz") {
    seen.push({ headers: req.headers, url: req.url ?? "" })
    if (req.headers["swarm-postage-batch-id"] !== BATCH) {
      res.writeHead(400).end(JSON.stringify({ code: 400, message: "invalid batch" }))
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const ref = hashBytes(body).slice(2)
    const reference = req.headers["swarm-encrypt"] === "true" ? ref + "b".repeat(64) : ref
    stored.set(reference, body)
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ reference }))
    return
  }
  const match = url.pathname.match(/^\/bzz\/([0-9a-f]+)$/)
  if (req.method === "GET" && match && stored.has(match[1]!)) {
    res.writeHead(200).end(stored.get(match[1]!))
    return
  }
  res.writeHead(404).end(JSON.stringify({ code: 404, message: "not found" }))
})

let swarm: SwarmClient
let installRoot: string
const REPO_TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "demo-mail-tool-1.0.17")

beforeAll(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r))
  swarm = new SwarmClient({ url: `http://127.0.0.1:${(bee.address() as AddressInfo).port}/`, batch: BATCH })
  installRoot = mkdtempSync(join(tmpdir(), "ceasenet-fixes-"))
})

afterAll(() => {
  bee.close()
  rmSync(installRoot, { recursive: true, force: true })
})

afterEach(() => {
  seen.length = 0
})

const text = (s: string) => new TextEncoder().encode(s)

describe("uploads", () => {
  it("sends the batch and returns a public reference", async () => {
    const ref = await swarm.upload("fix.json", text("hello"), { contentType: "application/json" })
    expect(isPublicSwarmRef(ref)).toBe(true)
    expect(seen[0]?.headers["swarm-postage-batch-id"]).toBe(BATCH)
    expect(seen[0]?.headers["content-type"]).toBe("application/json")
    expect(seen[0]?.url).toContain("name=fix.json")
    expect(seen[0]?.headers["swarm-encrypt"]).toBeUndefined()
    expect(new TextDecoder().decode(await swarm.read(ref))).toBe("hello")
  })

  it("asks for encryption and returns the long reference", async () => {
    const ref = await swarm.upload("evidence.json", text("secret"), { encrypt: true })
    expect(seen[0]?.headers["swarm-encrypt"]).toBe("true")
    expect(isEncryptedSwarmRef(ref)).toBe(true)
  })

  it("refuses to upload with no batch", async () => {
    const reader = new SwarmClient({ url: swarm.opts.url })
    expect(reader.canUpload).toBe(false)
    await expect(reader.upload("x", text("x"))).rejects.toThrow("postage batch")
  })

  it("reports a refusal from the node", async () => {
    const wrong = new SwarmClient({ url: swarm.opts.url, batch: "c".repeat(64) })
    await expect(wrong.upload("x", text("x"))).rejects.toThrow("HTTP 400")
  })

  it("does not take a short reference for an encrypted upload", async () => {
    const lying = new SwarmClient({
      url: "http://unused",
      batch: BATCH,
      fetch: (async () => new Response(JSON.stringify({ reference: "d".repeat(64) }), { status: 201 })) as typeof fetch,
    })
    await expect(lying.upload("x", text("x"), { encrypt: true })).rejects.toThrow("unexpected reference")
  })

  it("does not read anything that is not a reference", async () => {
    await expect(swarm.read("../../etc/passwd")).rejects.toThrow("not a Swarm reference")
  })

  it("reports a missing file", async () => {
    await expect(swarm.read("e".repeat(64))).rejects.toThrow("HTTP 404")
  })
})

describe("packages", () => {
  const files = readPackage(REPO_TOOL)

  it("keeps the hash through a bundle", () => {
    expect(measureFiles(decodeBundle(encodeBundle(files)))).toBe(measureDir(REPO_TOOL))
  })

  it("installs a fix only if it is the exact file the recall names", async () => {
    const ref = await swarm.upload("fix.json", encodeBundle(files))
    const { dir, file } = await fetchPackage(swarm, ref, measureDir(REPO_TOOL), installRoot)
    expect(file.name).toBe("demo-mail-tool")
    expect(file.version).toBe("1.0.17")
    expect(file.hash).toBe(measureDir(REPO_TOOL))
    expect(measureDir(dir)).toBe(measureDir(REPO_TOOL))
    expect(readFileSync(join(dir, "server.mjs"))).toEqual(readFileSync(join(REPO_TOOL, "server.mjs")))
  })

  it("writes nothing when the file on Swarm has been swapped", async () => {
    const swapped = files.map((f) => (f.path === "server.mjs" ? { ...f, content: text("steal()") } : f))
    const ref = await swarm.upload("fix.json", encodeBundle(swapped))
    await expect(fetchPackage(swarm, ref, measureDir(REPO_TOOL), installRoot)).rejects.toThrow("does not match")
    expect(existsSync(join(installRoot, measureFiles(swapped)))).toBe(false)
  })

  it.each(["../evil.mjs", "/etc/evil", "a/../../evil", "C:/evil", "a\\b", "./a", "a//b", ""])("refuses the file path %j", (path) => {
    const bundle = text(JSON.stringify({ format: "ceasenet.package/1", files: [{ path, base64: "" }] }))
    expect(() => decodeBundle(bundle)).toThrow()
  })

  it("refuses a file listed twice, and other files passed off as packages", () => {
    const twice = { format: "ceasenet.package/1", files: [{ path: "a", base64: "" }, { path: "a", base64: "" }] }
    expect(() => decodeBundle(text(JSON.stringify(twice)))).toThrow("twice")
    expect(() => decodeBundle(text(JSON.stringify({ format: "other", files: [] })))).toThrow("not a CeaseNet package")
    expect(() => decodeBundle(text("not json"))).toThrow()
  })
})

describe("sealed references", () => {
  const key = (n: string) => `0x${n.repeat(64)}` as const
  const regulator = privateKeyToAccount(key("1"))
  const ref = "f".repeat(128)

  it("opens only for the person it was sealed to", () => {
    const sealed = sealRef(ref, regulator.publicKey)
    expect(openSealedRef(sealed, key("1"))).toBe(ref)
    expect(() => openSealedRef(sealed, key("2"))).toThrow()
  })

  it("never shows the reference in the public record", () => {
    const sealed = sealRef(ref, regulator.publicKey)
    expect(sealed).not.toContain(ref)
    expect(sealed).not.toContain(ref.slice(64))
    expect(sealRef(ref, regulator.publicKey)).not.toBe(sealed)
  })

  it("fails when the seal has been changed", () => {
    const sealed = JSON.parse(sealRef(ref, regulator.publicKey))
    const flipped = JSON.stringify({ ...sealed, ct: (sealed.ct[0] === "0" ? "1" : "0") + sealed.ct.slice(1) })
    expect(() => openSealedRef(flipped, key("1"))).toThrow()
    expect(() => openSealedRef(JSON.stringify({ v: 2 }), key("1"))).toThrow("not sealed evidence")
  })

  it("only public references can go in public records", () => {
    expect(() => assertPublicRef("a".repeat(64))).not.toThrow()
    expect(() => assertPublicRef(undefined)).not.toThrow()
    expect(() => assertPublicRef("a".repeat(128))).toThrow("public Swarm reference")
    expect(() => assertPublicRef("https://example.com")).toThrow("public Swarm reference")
  })
})
