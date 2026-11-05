export type Hex = `0x${string}`

export type Mode = "RUNNING" | "SUPERVISED" | "STOPPED"
export type RecallLevel = "ADVISORY" | "STOP"
export type Stance = "CONFIRM" | "DISPUTE"
export type LiftKind = "FIX" | "WITHDRAWN" | "DISMISSED"
export type AckAction = "STOPPED" | "SLOWED" | "LEFT_SLOW" | "UPDATED" | "TOOL_BLOCKED" | "NEEDS_APPROVAL"

export interface LoadedFile {
  kind: string
  name: string
  version: string
  hash: string
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
  fixedRef?: string
  note?: string
  creator: Hex
  createdAt: bigint
}

export interface AckRow {
  key: Hex
  recall: Hex
  recallHash: string
  robot: Hex
  artifact: string
  action: AckAction
  issuer: Hex
  newHash?: string
  creator: Hex
  createdAt: bigint
}

export interface HeartbeatRow {
  key: Hex
  robot: Hex
  mode: Mode
  loadoutSeq: bigint
  creator: Hex
  updatedAt: bigint
  expiresAt: bigint
}

export interface LoadoutRow {
  key: Hex
  robot: Hex
  seq: bigint
  files: LoadedFile[]
  creator: Hex
  createdAt: bigint
}

export interface RobotRow {
  key: Hex
  robot: Hex
  maker: Hex
  model: string
  serial: string
  city: string
  creator: Hex
}
