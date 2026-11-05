import type { Timers } from "./timers"
import type { AckAction, EndorseRow, Hex, LiftRow, Mode, RecallRow } from "./types"

/** Keys a gate listens to. All comparisons are done on lowercase addresses. */
export interface TrustConfig {
  /** May issue a STOP: makers, regulators and publishers, or an owner's chosen issuers. */
  stopKeys: ReadonlySet<string>
  /** May lift any STOP and dismiss advisories. */
  regulators: ReadonlySet<string>
  /** The only key allowed to create advisories and confirmations. */
  verifier: string
  threshold: number
  windowBlocks: bigint
}

export const lower = (a: string): string => a.toLowerCase()

export function makeTrust(input: {
  stopKeys: readonly string[]
  regulators: readonly string[]
  verifier: string
  threshold: number
  windowBlocks: bigint
}): TrustConfig {
  return {
    stopKeys: new Set(input.stopKeys.map(lower)),
    regulators: new Set(input.regulators.map(lower)),
    verifier: lower(input.verifier),
    threshold: input.threshold,
    windowBlocks: input.windowBlocks,
  }
}

/** A STOP counts only if an accountable key created it. Labels prove nothing. */
export function isTrustedStop(r: RecallRow, trust: TrustConfig): boolean {
  return r.level === "STOP" && trust.stopKeys.has(lower(r.creator))
}

/** An advisory counts only if the verifier created it, which means a human or a passed scanner filed it. */
export function isTrustedAdvisory(r: RecallRow, trust: TrustConfig): boolean {
  return r.level === "ADVISORY" && lower(r.creator) === trust.verifier
}

/** Only the key that issued a STOP, or a regulator, can take it back. */
export function isWithdrawn(stop: RecallRow, lifts: readonly LiftRow[], trust: TrustConfig): boolean {
  return lifts.some(
    (l) =>
      l.recall === stop.key &&
      l.kind === "WITHDRAWN" &&
      (lower(l.creator) === lower(stop.creator) || trust.regulators.has(lower(l.creator))),
  )
}

/** Only a regulator can dismiss an advisory. */
export function isDismissed(advisory: RecallRow, lifts: readonly LiftRow[], trust: TrustConfig): boolean {
  return lifts.some(
    (l) => l.recall === advisory.key && l.kind === "DISMISSED" && trust.regulators.has(lower(l.creator)),
  )
}

/** A fix published by the issuer or a regulator. Robots still on the old file stay stopped. */
export function fixFor(stop: RecallRow, lifts: readonly LiftRow[], trust: TrustConfig): LiftRow | undefined {
  return lifts.find(
    (l) =>
      l.recall === stop.key &&
      l.kind === "FIX" &&
      l.fixedHash !== undefined &&
      (lower(l.creator) === lower(stop.creator) || trust.regulators.has(lower(l.creator))),
  )
}

export interface ConfirmationCount {
  confirms: number
  disputes: number
  /** Confirmations that count: zero unless confirmations outnumber disputes. */
  effective: number
}

/**
 * Counts verifier-created confirmations from inside the window, one per human.
 *
 * The window is enforced here from the creation block. An owner can always extend their own entities,
 * so an entity still existing does not prove a confirmation is fresh.
 */
export function countConfirmations(
  advisory: RecallRow,
  endorsements: readonly EndorseRow[],
  currentBlock: bigint,
  trust: TrustConfig,
): ConfirmationCount {
  const yes = new Set<string>()
  const no = new Set<string>()
  for (const e of endorsements) {
    if (e.recall !== advisory.key) continue
    if (lower(e.creator) !== trust.verifier) continue
    if (currentBlock - e.createdAt > trust.windowBlocks) continue
    ;(e.stance === "CONFIRM" ? yes : no).add(e.human)
  }
  return {
    confirms: yes.size,
    disputes: no.size,
    effective: yes.size > no.size ? yes.size : 0,
  }
}

export interface Connectivity {
  online: boolean
  /** How long Arkiv has been unreachable. Zero while online. */
  offlineForMs: number
}

export interface GateInput {
  hashes: readonly string[]
  /** Every trusted STOP this gate has ever seen, including ones that have since vanished from Arkiv. */
  rememberedStops: readonly RecallRow[]
  /** Every lift this gate has ever seen. */
  rememberedLifts: readonly LiftRow[]
  advisories: readonly RecallRow[]
  endorsements: readonly EndorseRow[]
  currentBlock: bigint
  connectivity: Connectivity
  /** Advisories that had the gate supervised when Arkiv was last readable. */
  lastSupervised: readonly RecallRow[]
  trust: TrustConfig
  timers: Pick<Timers, "graceMs" | "offlineSupervisedMs">
}

export type Reason =
  | { type: "CLEAR" }
  | { type: "STOP"; recall: RecallRow }
  | { type: "CONFIRMED_ADVISORY"; recall: RecallRow; confirmations: number }
  | { type: "OFFLINE_GRACE" }
  | { type: "OFFLINE_SUPERVISED" }
  | { type: "OFFLINE_STOP" }

export interface GateDecision {
  mode: Mode
  reasons: Reason[]
  activeStops: RecallRow[]
  activeAdvisories: RecallRow[]
}

/**
 * What the robot must do right now. Pure, so every rule can be tested.
 *
 * Order matters: remembered STOPs apply first, because losing the internet must never restart a robot
 * that has already been told to stop.
 */
export function evaluate(input: GateInput): GateDecision {
  const { hashes, trust, connectivity } = input
  const loaded = new Set(hashes.map(lower))

  const activeStops = input.rememberedStops.filter(
    (r) =>
      isTrustedStop(r, trust) && loaded.has(lower(r.artifact)) && !isWithdrawn(r, input.rememberedLifts, trust),
  )
  if (activeStops.length > 0) {
    return {
      mode: "STOPPED",
      reasons: activeStops.map((recall) => ({ type: "STOP", recall })),
      activeStops,
      activeAdvisories: [],
    }
  }

  if (!connectivity.online) {
    const { graceMs, offlineSupervisedMs } = input.timers
    if (connectivity.offlineForMs >= graceMs + offlineSupervisedMs) {
      return { mode: "STOPPED", reasons: [{ type: "OFFLINE_STOP" }], activeStops: [], activeAdvisories: [] }
    }
    if (input.lastSupervised.length > 0) {
      return {
        mode: "SUPERVISED",
        reasons: input.lastSupervised.map((recall) => ({ type: "CONFIRMED_ADVISORY", recall, confirmations: 0 })),
        activeStops: [],
        activeAdvisories: [...input.lastSupervised],
      }
    }
    if (connectivity.offlineForMs >= graceMs) {
      return { mode: "SUPERVISED", reasons: [{ type: "OFFLINE_SUPERVISED" }], activeStops: [], activeAdvisories: [] }
    }
    return { mode: "RUNNING", reasons: [{ type: "OFFLINE_GRACE" }], activeStops: [], activeAdvisories: [] }
  }

  const reasons: Reason[] = []
  const activeAdvisories: RecallRow[] = []
  for (const a of input.advisories) {
    if (!isTrustedAdvisory(a, trust) || !loaded.has(lower(a.artifact))) continue
    if (isDismissed(a, input.rememberedLifts, trust)) continue
    const { effective } = countConfirmations(a, input.endorsements, input.currentBlock, trust)
    if (effective >= trust.threshold) {
      activeAdvisories.push(a)
      reasons.push({ type: "CONFIRMED_ADVISORY", recall: a, confirmations: effective })
    }
  }
  if (activeAdvisories.length > 0) {
    return { mode: "SUPERVISED", reasons, activeStops: [], activeAdvisories }
  }

  return { mode: "RUNNING", reasons: [{ type: "CLEAR" }], activeStops: [], activeAdvisories: [] }
}

export interface AckIntent {
  recall: RecallRow
  action: AckAction
}

/** Receipts owed after a decision. Each recall and action is receipted once. */
export function acksOwed(
  decision: GateDecision,
  previouslySupervised: readonly RecallRow[],
  alreadyAcked: ReadonlySet<string>,
): AckIntent[] {
  const owed: AckIntent[] = []
  const add = (recall: RecallRow, action: AckAction) => {
    if (!alreadyAcked.has(ackId(recall.key, action))) owed.push({ recall, action })
  }
  for (const r of decision.activeStops) add(r, "STOPPED")
  for (const r of decision.activeAdvisories) add(r, "SLOWED")
  for (const r of previouslySupervised) {
    if (decision.mode === "RUNNING" && !decision.activeAdvisories.some((a) => a.key === r.key)) {
      add(r, "LEFT_SLOW")
    }
  }
  return owed
}

export const ackId = (recall: Hex, action: AckAction): string => `${recall}:${action}`

/** Remembered STOPs that no longer exist on Arkiv and were never properly lifted. */
export function vanishedStops(
  rememberedStops: readonly RecallRow[],
  seenOnArkiv: readonly RecallRow[],
  rememberedLifts: readonly LiftRow[],
  trust: TrustConfig,
): RecallRow[] {
  const live = new Set(seenOnArkiv.map((r) => r.key))
  return rememberedStops.filter((r) => !live.has(r.key) && !isWithdrawn(r, rememberedLifts, trust))
}
