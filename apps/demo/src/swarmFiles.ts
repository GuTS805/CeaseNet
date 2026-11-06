import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { encodeBundle } from "@ceasenet/core"
import { readPackage, SwarmClient } from "@ceasenet/guard"
import type { ToolPackage } from "./catalog"
import { STATE_DIR } from "./store"

const CACHE = join(STATE_DIR, "swarm-refs.json")

type Refs = Record<string, string>

const readCache = (): Refs => (existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf8")) as Refs) : {})

/** Reuses what is already stored: an upload spends postage, and the same bytes always get the same public reference. */
async function once(name: string, upload: () => Promise<string>): Promise<string> {
  const known = readCache()[name]
  if (known) return known
  const reference = await upload()
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ ...readCache(), [name]: reference }, null, 2))
  return reference
}

/** The public copy of a tool, so anyone can fetch a fix without trusting whoever serves it. */
export const uploadPackage = (swarm: SwarmClient, pkg: ToolPackage): Promise<string> =>
  once(`package:${pkg.file.hash}`, () =>
    swarm.upload(`${pkg.file.name}-${pkg.file.version}.ceasenet.json`, encodeBundle(readPackage(pkg.dir)), { contentType: "application/json" }),
  )

/** What a recall's evidence is: the finding, and the exact code it points at. */
export function evidenceFor(pkg: ToolPackage): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(
      {
        tool: pkg.file.name,
        version: pkg.file.version,
        hash: pkg.file.hash,
        finding: "Every email sent through this tool is also copied to an address nobody asked for.",
        where: "server.mjs",
        code: readFileSync(join(pkg.dir, "server.mjs"), "utf8"),
      },
      null,
      2,
    ),
  )
}

/** Encrypted on Swarm. The reference holds the key, so it stays off public records until it has been sealed. */
export const uploadSealedEvidence = (swarm: SwarmClient, pkg: ToolPackage): Promise<string> =>
  once(`evidence:${pkg.file.hash}`, () =>
    swarm.upload("evidence.json", evidenceFor(pkg), { contentType: "application/json", encrypt: true }),
  )

/** The same evidence, public, for after the disclosure deadline. */
export const uploadPublicEvidence = (swarm: SwarmClient, pkg: ToolPackage): Promise<string> =>
  once(`disclosure:${pkg.file.hash}`, () =>
    swarm.upload("evidence.json", evidenceFor(pkg), { contentType: "application/json" }),
  )
