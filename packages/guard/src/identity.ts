import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ADDRESSES, CONFIRMATION_THRESHOLD, type Hex, type TrustPolicy } from "@ceasenet/core"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

/** What `ceasenet` keeps on this machine. The file holds keys, so it is never printed and is readable only by its owner. */
export interface Identity {
  name: string
  /** Signs the agent's own records: what it loaded, heartbeats and receipts. */
  agentKey: Hex
  /** Present when this machine holds the owner's key. Otherwise the owner signs on the website, with a browser wallet. */
  ownerKey?: Hex
  ownerAddress: Hex
  /** Whose STOPs this agent obeys. It works before anything is published, and once published the public list decides. */
  following: Hex[]
  accessKey?: string
}

export const homeDir = (): string => process.env.CEASENET_HOME || join(homedir(), ".ceasenet")
const identityPath = (home: string) => join(home, "identity.json")

export const agentAddress = (identity: Identity): Hex => privateKeyToAccount(identity.agentKey).address

export const isAddress = (value: string): value is Hex => /^0x[0-9a-fA-F]{40}$/.test(value)

export function loadIdentity(home = homeDir()): Identity | undefined {
  const path = identityPath(home)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Identity) : undefined
}

export function saveIdentity(identity: Identity, home = homeDir()): void {
  mkdirSync(home, { recursive: true })
  const path = identityPath(home)
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Creates the keys once. Running it again keeps what is there, because a lost key cannot be recovered. */
export function createIdentity(input: { name: string; owner?: string; accessKey?: string }, home = homeDir()): { identity: Identity; created: boolean } {
  const existing = loadIdentity(home)
  if (existing) return { identity: existing, created: false }
  if (input.owner !== undefined && !isAddress(input.owner)) throw new Error(`"${input.owner}" is not an address`)
  const ownerKey = input.owner ? undefined : generatePrivateKey()
  const identity: Identity = {
    name: input.name,
    agentKey: generatePrivateKey(),
    ...(ownerKey ? { ownerKey } : {}),
    ownerAddress: (input.owner as Hex | undefined) ?? privateKeyToAccount(ownerKey!).address,
    following: [],
    ...(input.accessKey ? { accessKey: input.accessKey } : {}),
  }
  saveIdentity(identity, home)
  return { identity, created: true }
}

/** The list an agent starts from. Warnings still come from the public verifier, and need real people to confirm them before they do anything. */
export const policyFor = (identity: Pick<Identity, "following">): TrustPolicy => ({
  issuers: identity.following,
  regulators: [],
  verifier: ADDRESSES.verifier,
  threshold: CONFIRMATION_THRESHOLD,
})

/** Adds or removes a key, ignoring letter case. */
export function changeFollowing(following: readonly Hex[], address: Hex, follow: boolean): Hex[] {
  const others = following.filter((a) => a.toLowerCase() !== address.toLowerCase())
  return follow ? [...others, address] : others
}
