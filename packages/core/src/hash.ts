import { keccak256, stringToBytes } from "viem"
import type { Hex } from "./types"

export function hashBytes(data: Uint8Array | string): Hex {
  return keccak256(typeof data === "string" ? stringToBytes(data) : data)
}

/** JSON with sorted keys, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString()
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return v
  })
}

/** Ties a World ID proof to one warning and one answer, so it cannot be replayed on another. */
export const confirmationSignal = (recall: string, stance: string): string => `${recall.toLowerCase()}:${stance}`

/** Ties a World ID proof to one report, so it cannot be replayed to file a different one. */
export const reportSignal = (artifact: string, reason: string): string => `report:${hashBytes(`${artifact.toLowerCase()}\n${reason}`)}`

export interface RecallContent {
  artifact: string
  level: string
  severity: string
  reason: string
}

/** Receipts carry this, so a STOP stays provable after its issuer deletes it. */
export function recallContentHash(c: RecallContent): Hex {
  return hashBytes(
    canonicalJson({ artifact: c.artifact.toLowerCase(), level: c.level, severity: c.severity, reason: c.reason }),
  )
}

/** Ties a World ID login to one wallet address, so the proof cannot be used to log in with another. */
export const loginSignal = (address: string): string => `login:${address.toLowerCase()}`

/** How long a signed request stays good. Long enough to finish, short enough that an old one is useless. */
export const SIGNED_REQUEST_MS = 10 * 60_000

/** What a wallet signs to log in. Signing costs nothing and sends nothing. */
export const loginMessage = (address: string, at: number): string =>
  `CeaseNet login\nAddress: ${address.toLowerCase()}\nAt: ${at}\n\nThis proves the wallet is yours. It costs nothing and sends nothing.`

/** What a logged-in wallet signs to vote on a normal recall. */
export const voteMessage = (recall: string, stance: string, at: number): string =>
  `CeaseNet vote\nRecall: ${recall.toLowerCase()}\nVote: ${stance}\nAt: ${at}`

/** What a logged-in wallet signs to open a normal recall. */
export const openRecallMessage = (artifact: string, reason: string, at: number): string =>
  `CeaseNet open a recall\nOn: ${artifact.toLowerCase()}\nReason hash: ${hashBytes(reason)}\nAt: ${at}`
