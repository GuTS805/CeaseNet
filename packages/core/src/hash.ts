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
