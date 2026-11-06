import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  decodeBundle,
  describePackage,
  type Hex,
  isEncryptedSwarmRef,
  isPublicSwarmRef,
  type LoadedFile,
  measureFiles,
} from "@ceasenet/core"
import { measureDir } from "./measure"

const TIMEOUT_MS = 60_000
const MAX_READ_BYTES = 20 * 1024 * 1024

export interface SwarmOptions {
  /** A Bee node, or a service that speaks the same API. */
  url: string
  /** Needed for uploads only. Reading is free. */
  batch?: string
  fetch?: typeof fetch
}

/** Speaks Bee's HTTP API directly. */
export class SwarmClient {
  private readonly url: string
  private readonly doFetch: typeof fetch

  constructor(readonly opts: SwarmOptions) {
    this.url = opts.url.replace(/\/+$/, "")
    this.doFetch = opts.fetch ?? fetch
  }

  get canUpload(): boolean {
    return Boolean(this.opts.batch)
  }

  /**
   * Stores one file. With `encrypt`, the reference that comes back is 64 bytes and holds the key to the file,
   * so it must never go in a public record as it is: see {@link sealRef}.
   */
  async upload(name: string, data: Uint8Array, options: { contentType?: string; encrypt?: boolean } = {}): Promise<string> {
    if (!this.opts.batch) throw new Error("uploading to Swarm needs a postage batch")
    const res = await this.doFetch(`${this.url}/bzz?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/octet-stream",
        "swarm-postage-batch-id": this.opts.batch,
        ...(options.encrypt ? { "swarm-encrypt": "true" } : {}),
      },
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Swarm refused the upload: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const { reference } = (await res.json()) as { reference?: string }
    const valid = options.encrypt ? isEncryptedSwarmRef : isPublicSwarmRef
    if (!reference || !valid(reference)) {
      throw new Error(`Swarm returned an unexpected reference for ${options.encrypt ? "an encrypted" : "a public"} upload`)
    }
    return reference
  }

  async read(reference: string): Promise<Uint8Array> {
    if (!isPublicSwarmRef(reference) && !isEncryptedSwarmRef(reference)) throw new Error("this is not a Swarm reference")
    const res = await this.doFetch(`${this.url}/bzz/${reference}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Swarm could not find that file: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > MAX_READ_BYTES) throw new Error("the file on Swarm is too large")
    return bytes
  }
}

/**
 * Downloads a published fix and unpacks it, but only if it is exactly the file the recall names.
 * The hash is checked before anything reaches the disk, so whoever serves the file does not need to be trusted.
 */
export async function fetchPackage(
  swarm: SwarmClient,
  reference: string,
  expectedHash: string,
  installRoot: string,
): Promise<{ dir: string; file: LoadedFile }> {
  const files = decodeBundle(await swarm.read(reference))
  const actual = measureFiles(files)
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`the file on Swarm does not match the published fix (${actual.slice(0, 10)}, expected ${expectedHash.slice(0, 10)})`)
  }
  const file = describePackage(files)
  const dir = join(installRoot, actual)
  for (const f of files) {
    const path = join(dir, ...f.path.split("/"))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, f.content)
  }
  // Anything left in that folder from before would run too, so what is on disk has to measure the same.
  if (measureDir(dir).toLowerCase() !== actual.toLowerCase()) throw new Error(`${dir} holds other files, so the fix was not installed`)
  return { dir, file }
}

const SEAL_ALGORITHM = "secp256k1-hkdf-sha256-aes-256-gcm"
const SEAL_INFO = "ceasenet.sealed-evidence.v1"

interface Sealed {
  v: 1
  alg: typeof SEAL_ALGORITHM
  epk: string
  iv: string
  ct: string
  tag: string
}

const toBuffer = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex")
const keyFrom = (secret: Buffer, ephemeral: Buffer) => Buffer.from(hkdfSync("sha256", secret, ephemeral, SEAL_INFO, 32))

/**
 * Seals a Swarm reference to one person's public key, so it can sit in a public record.
 * An encrypted reference holds the key to its file: only the person who can open this seal can read that file.
 */
export function sealRef(reference: string, recipientPublicKey: Hex): string {
  if (!isPublicSwarmRef(reference) && !isEncryptedSwarmRef(reference)) throw new Error("this is not a Swarm reference")
  const recipient = toBuffer(recipientPublicKey)
  const ephemeral = createECDH("secp256k1")
  const epk = ephemeral.generateKeys()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyFrom(ephemeral.computeSecret(recipient), epk), iv)
  cipher.setAAD(epk)
  const ct = Buffer.concat([cipher.update(reference, "utf8"), cipher.final()])
  const sealed: Sealed = {
    v: 1,
    alg: SEAL_ALGORITHM,
    epk: epk.toString("hex"),
    iv: iv.toString("hex"),
    ct: ct.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  }
  return JSON.stringify(sealed)
}

/** Throws if this key is not the one the reference was sealed to, or the seal was changed. */
export function openSealedRef(sealedText: string, privateKey: Hex): string {
  const sealed = JSON.parse(sealedText) as Partial<Sealed>
  if (sealed.v !== 1 || sealed.alg !== SEAL_ALGORITHM || !sealed.epk || !sealed.iv || !sealed.ct || !sealed.tag) {
    throw new Error("this is not sealed evidence")
  }
  const me = createECDH("secp256k1")
  me.setPrivateKey(toBuffer(privateKey))
  const epk = toBuffer(sealed.epk)
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(me.computeSecret(epk), epk), toBuffer(sealed.iv))
  decipher.setAAD(epk)
  decipher.setAuthTag(toBuffer(sealed.tag))
  return Buffer.concat([decipher.update(toBuffer(sealed.ct)), decipher.final()]).toString("utf8")
}
