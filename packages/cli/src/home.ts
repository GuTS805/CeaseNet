import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Hex, identityFiles, type LoadedFile, ownerOnlyPolicy, teamFile, type TrustPolicy } from "@ceasenet/core"
import { writeAtomic } from "@ceasenet/guard"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

/** Everything CeaseNet keeps on a machine lives under one folder. */
export const homeDir = (): string => process.env.CEASENET_HOME ?? join(homedir(), ".ceasenet")
export const inHome = (...parts: string[]): string => join(homeDir(), ...parts)

/** A team's agents each have a home of their own inside their owner's. This points back to it. */
export const mainHome = (): string => process.env.CEASENET_MAIN_HOME ?? homeDir()

export type Network = "arkiv" | "local"

export interface Config {
  /** arkiv: the public list, which reaches any machine. local: this machine only, with no wallet or tokens. */
  network: Network
  agent: { name: string; address: Hex }
  /** Who answers for this agent. Their key may live on another machine. */
  owner: { address: Hex }
  /** Not a secret: the Arkiv SDK puts it in the RPC URL. Optional: it has a quota, and the public endpoint takes over when that runs out. */
  accessKey: string
  /** Where the local list is kept, so several agents on one machine can share an owner. */
  ledgerFile?: string
  port: number
  /** One of the team of three, which can be stopped together. */
  team?: boolean
}

export interface Keys {
  agent: Hex
  /** Absent when the owner's key is kept elsewhere. Then this machine can obey the owner, but not speak for them. */
  owner?: Hex
}

export const DEFAULT_PORT = 7787

export const configExists = (): boolean => existsSync(inHome("config.json"))

export function loadConfig(): Config {
  if (!configExists()) throw new Error("CeaseNet is not set up on this machine. Run: ceasenet init")
  return JSON.parse(readFileSync(inHome("config.json"), "utf8")) as Config
}

export const saveConfig = (config: Config): void => writeAtomic(inHome("config.json"), `${JSON.stringify(config, null, 2)}\n`)

export function loadKeys(): Keys {
  return JSON.parse(readFileSync(inHome("keys.json"), "utf8")) as Keys
}

function saveKeys(keys: Keys, dir = homeDir()): void {
  mkdirSync(dir, { recursive: true })
  // Readable only by this user on Linux and macOS. On Windows, a folder in the user's profile already is.
  writeFileSync(join(dir, "keys.json"), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
}

/** Gives a team's agent a home of its own: its own key, the same owner, the same list. */
export function createMemberHome(dir: string, member: { name: string }, config: Config): Config {
  const path = join(dir, "config.json")
  const ledgerFile = config.ledgerFile ?? join(homeDir(), "ledger.jsonl")
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8")) as Config
    // The owner may have moved to the public list since this agent was made.
    const next: Config = { ...existing, network: config.network, accessKey: config.accessKey, owner: config.owner, ledgerFile, team: true }
    writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }
  const agent = generatePrivateKey()
  saveKeys({ agent }, dir)
  const created: Config = {
    network: config.network,
    agent: { name: member.name, address: privateKeyToAccount(agent).address },
    owner: config.owner,
    accessKey: config.accessKey,
    ledgerFile,
    port: config.port,
    team: true,
  }
  writeAtomic(path, `${JSON.stringify(created, null, 2)}\n`)
  return created
}

/** Everything that names this agent: a STOP aimed at any of these stops the whole agent. */
export const identityOf = (config: Config): LoadedFile[] => [
  ...identityFiles(config.agent.address, config.owner.address),
  ...(config.team ? [teamFile(config.owner.address)] : []),
]

export interface InitOptions {
  name: string
  network: Network
  accessKey: string
  /** Follow an owner whose key lives elsewhere, rather than creating one here. */
  owner?: Hex
  ledgerFile?: string
  port?: number
}

/** Creates this agent's identity. It refuses to replace one, because that would orphan its records and funds. */
export function initHome(options: InitOptions): { config: Config; created: boolean } {
  if (configExists()) return { config: loadConfig(), created: false }
  const agent = generatePrivateKey()
  const owner = options.owner ? undefined : generatePrivateKey()
  saveKeys({ agent, ...(owner ? { owner } : {}) })
  const config: Config = {
    network: options.network,
    agent: { name: options.name, address: privateKeyToAccount(agent).address },
    owner: { address: options.owner ?? privateKeyToAccount(owner!).address },
    accessKey: options.accessKey,
    ...(options.ledgerFile ? { ledgerFile: options.ledgerFile } : {}),
    port: options.port ?? DEFAULT_PORT,
  }
  saveConfig(config)
  return { config, created: true }
}

/**
 * Whom an agent obeys: its owner, and nobody else. No key of ours is on it, and nobody else's either.
 * People's votes reach an agent only when its owner approves them with a STOP of their own.
 */
export const startingPolicy = (owner: Hex): TrustPolicy => ownerOnlyPolicy(owner)

/**
 * An agent obeys only its owner, whatever list was published for it before. A list naming other keys used to let
 * their STOPs through as well. Now an agent matches its owner's wallet and nothing else counts.
 */
export const obeyingOwner = (_policy: TrustPolicy, owner: string): TrustPolicy => ownerOnlyPolicy(owner)

/** Safe to use as a file name on any system. */
export const safeName = (name: string): string => name.replace(/[^\w.@-]/g, "_")

// ---- Telling other CeaseNet processes on this machine that something changed ----

const NUDGE = "nudge"

/** Tells every running gate to read the list now, rather than at its next turn. */
export const nudge = (): void => {
  mkdirSync(mainHome(), { recursive: true })
  writeFileSync(join(mainHome(), NUDGE), String(Date.now()))
}

export function nudgeTime(): number {
  try {
    return statSync(join(mainHome(), NUDGE)).mtimeMs
  } catch {
    return 0
  }
}

// ---- Tools whose owner approves each call ----

export function loadHolds(): string[] {
  try {
    return JSON.parse(readFileSync(inHome("holds.json"), "utf8")) as string[]
  } catch {
    return []
  }
}

export function setHold(tool: string, hold: boolean): string[] {
  const holds = new Set(loadHolds())
  if (hold) holds.add(tool)
  else holds.delete(tool)
  const next = [...holds]
  writeAtomic(inHome("holds.json"), JSON.stringify(next))
  return next
}
