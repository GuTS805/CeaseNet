export type Hex = `0x${string}`

/** What the gate allows. RUNNING: go ahead. SUPERVISED: a human must approve. STOPPED: refused. */
export type Mode = "RUNNING" | "SUPERVISED" | "STOPPED"
/** An agent's overall state. PAUSED means its AI model cannot be reached, so it is not acting. */
export type AgentStatus = Mode | "PAUSED"
export type RecallLevel = "ADVISORY" | "STOP"
export type Stance = "CONFIRM" | "DISPUTE"
export type LiftKind = "FIX" | "WITHDRAWN" | "DISMISSED"
/**
 * A receipt says what an agent did about a recall.
 * BLOCKED: it refuses to use the file. SUPERVISED: it asks a human first.
 * CLEARED: a warning no longer applies. UPDATED: it moved to the fixed version.
 */
export type AckAction = "BLOCKED" | "SUPERVISED" | "CLEARED" | "UPDATED"

/** One thing an agent has loaded. Tools can be blocked one by one. A recalled model or prompt stops the agent. */
export interface LoadedFile {
  kind: string
  name: string
  version: string
  hash: string
}

/** An owner's public choice of whom their agents obey. */
export interface TrustPolicy {
  /** Whose STOPs are obeyed. */
  issuers: string[]
  /** Who may also lift someone else's STOP and dismiss a warning. */
  regulators: string[]
  /** The service whose human-checked warnings are followed. */
  verifier: string
  /** How many verified humans must confirm a warning before a human must approve each call. */
  threshold: number
}

export interface RecallRow {
  key: Hex
  artifact: string
  level: RecallLevel
  severity: string
  reason: string
  contentHash: string
  creator: Hex
  createdAt: bigint
  expiresAt: bigint
  advice?: string
  sealedEvidence?: string
  pkg?: string
  versions?: string
  /** On a normal recall, the logged-in person who opened it. */
  opener?: Hex
  /** On an owner's STOP, the normal recall it approves. */
  approves?: Hex
}

/** A wallet address one real person logged in with, as the verifier recorded it. */
export interface HumanRow {
  key: Hex
  address: Hex
  human: string
  creator: Hex
  createdAt: bigint
}

export interface EndorseRow {
  key: Hex
  recall: Hex
  stance: Stance
  human: string
  creator: Hex
  createdAt: bigint
}

export interface LiftRow {
  key: Hex
  recall: Hex
  artifact: string
  kind: LiftKind
  fixedHash?: string
  fixedVersion?: string
  fixedRef?: string
  note?: string
  creator: Hex
  createdAt: bigint
}

export interface AckRow {
  key: Hex
  recall: Hex
  recallHash: string
  agent: Hex
  artifact: string
  action: AckAction
  issuer: Hex
  newHash?: string
  creator: Hex
  createdAt: bigint
}

export interface HeartbeatRow {
  key: Hex
  agent: Hex
  mode: AgentStatus
  loadoutSeq: bigint
  creator: Hex
  updatedAt: bigint
  expiresAt: bigint
}

export interface LoadoutRow {
  key: Hex
  agent: Hex
  seq: bigint
  files: LoadedFile[]
  fingerprint?: string
  creator: Hex
  createdAt: bigint
}

export interface AgentRow {
  key: Hex
  agent: Hex
  owner: Hex
  name: string
  framework: string
  purpose: string
  creator: Hex
}

export interface DiaryRow {
  key: Hex
  agent: Hex
  root: string
  head: string
  entries: bigint
  firstSeq: bigint
  lastSeq: bigint
  /** How the part is kept. Without one it is a readable file on 0G Storage. */
  storage?: string
  /** When its first and last entries happened, in milliseconds since 1970. Parts written before these existed have neither. */
  firstAt?: number
  lastAt?: number
  creator: Hex
  createdAt: bigint
}

/** A span of time to look up what an agent did in, in milliseconds since 1970. Either end may be left open. */
export interface TimeRange {
  from?: number
  to?: number
}

export interface ArtifactRow {
  key: Hex
  hash: string
  kind: string
  name: string
  version: string
  creator: Hex
  source?: string
}
