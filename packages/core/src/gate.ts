import semver from "semver"
import { CONFIRMATION_THRESHOLD, CONFIRMATION_WINDOW_BLOCKS, type Timers } from "./timers"
import type { AckAction, EndorseRow, Hex, LiftRow, LoadedFile, Mode, RecallRow, TrustPolicy } from "./types"

/** Keys a gate listens to. All comparisons are done on lowercase addresses. */
export interface TrustConfig {
  /** May issue a STOP this gate obeys. */
  stopKeys: ReadonlySet<string>
  /** May also lift any STOP and dismiss warnings. */
  regulators: ReadonlySet<string>
  /** The only key allowed to create warnings and confirmations. */
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

/**
 * An agent obeys its owner and nobody else. A STOP binds it only when its owner's wallet signed it, and a normal
 * recall only reaches it once the owner approves it with such a STOP.
 */
export const ownerOnlyPolicy = (owner: string): TrustPolicy => ({
  issuers: [owner],
  regulators: [],
  verifier: owner,
  threshold: CONFIRMATION_THRESHOLD,
})

export const trustFromPolicy = (policy: TrustPolicy): TrustConfig =>
  makeTrust({
    stopKeys: policy.issuers,
    regulators: policy.regulators,
    verifier: policy.verifier,
    threshold: policy.threshold,
    windowBlocks: CONFIRMATION_WINDOW_BLOCKS,
  })

/**
 * Whether a recall covers a file: by exact hash, or by package name and version range.
 * A range that cannot be read covers nothing, so a badly written recall cannot stop what it did not name.
 */
export function recallCovers(recall: RecallRow, file: LoadedFile): boolean {
  if (lower(recall.artifact) === lower(file.hash)) return true
  if (!recall.pkg || !recall.versions || recall.pkg !== file.name) return false
  if (semver.validRange(recall.versions) === null || semver.valid(file.version) === null) return false
  return semver.satisfies(file.version, recall.versions)
}

/** A STOP counts only if a key this gate follows created it. Labels prove nothing. */
export function isTrustedStop(r: RecallRow, trust: TrustConfig): boolean {
  return r.level === "STOP" && trust.stopKeys.has(lower(r.creator))
}

/** A warning counts only if the verifier created it, which means a human or a passed scanner filed it. */
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

/** Only a regulator can dismiss a warning. */
export function isDismissed(advisory: RecallRow, lifts: readonly LiftRow[], trust: TrustConfig): boolean {
  return lifts.some(
    (l) => l.recall === advisory.key && l.kind === "DISMISSED" && trust.regulators.has(lower(l.creator)),
  )
}

/** A fix published by the issuer or a regulator. Agents still on the old version stay blocked. */
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
  files: readonly LoadedFile[]
  /** Every trusted STOP this gate has ever seen, including ones that have since vanished from Arkiv. */
  rememberedStops: readonly RecallRow[]
  /** Every lift this gate has ever seen. */
  rememberedLifts: readonly LiftRow[]
  advisories: readonly RecallRow[]
  endorsements: readonly EndorseRow[]
  currentBlock: bigint
  connectivity: Connectivity
  /** Warnings that required human approval when Arkiv was last readable. */
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
 * What may happen with these files right now. Pure, so every rule can be tested.
 *
 * Order matters: remembered STOPs apply first, because losing the internet must never bring back
 * something an agent has already been told to stop using.
 */
export function evaluate(input: GateInput): GateDecision {
  const { files, trust, connectivity } = input
  const covered = (r: RecallRow) => files.some((f) => recallCovers(r, f))

  const activeStops = input.rememberedStops.filter(
    (r) => isTrustedStop(r, trust) && covered(r) && !isWithdrawn(r, input.rememberedLifts, trust),
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
    const stillSupervised = input.lastSupervised.filter(covered)
    if (stillSupervised.length > 0) {
      return {
        mode: "SUPERVISED",
        reasons: stillSupervised.map((recall) => ({ type: "CONFIRMED_ADVISORY", recall, confirmations: 0 })),
        activeStops: [],
        activeAdvisories: stillSupervised,
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
    if (!isTrustedAdvisory(a, trust) || !covered(a)) continue
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

/** Tools and skills can be blocked one at a time. Anything else, such as a model or prompt, is the agent itself. */
export const isReplaceable = (file: LoadedFile): boolean => file.kind === "tool" || file.kind === "skill"

export interface FileDecision {
  file: LoadedFile
  decision: GateDecision
}

export interface AgentDecision {
  /** The agent's model and prompt. A STOP here stops the whole agent. */
  core: GateDecision
  coreFiles: LoadedFile[]
  /** One decision per tool, so one bad tool does not take the agent down. */
  tools: FileDecision[]
}

export function evaluateAgent(input: GateInput): AgentDecision {
  const coreFiles = input.files.filter((f) => !isReplaceable(f))
  return {
    core: evaluate({ ...input, files: coreFiles }),
    coreFiles,
    tools: input.files
      .filter(isReplaceable)
      .map((file) => ({ file, decision: evaluate({ ...input, files: [file] }) })),
  }
}

export type CallVerdict = "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"

/** The stricter of the agent's own state and the tool's state decides. */
export function verdictFor(agent: AgentDecision, toolHash: string): CallVerdict {
  const tool = agent.tools.find((t) => lower(t.file.hash) === lower(toolHash))
  // A tool the gate was not told about is not allowed through.
  if (!tool) return "BLOCK"
  const modes = [agent.core.mode, tool.decision.mode]
  if (modes.includes("STOPPED")) return "BLOCK"
  if (modes.includes("SUPERVISED")) return "NEEDS_APPROVAL"
  return "ALLOW"
}

export interface AckIntent {
  recall: RecallRow
  action: AckAction
}

export const ackId = (recall: Hex, action: AckAction): string => `${recall}:${action}`

/** Receipts owed after a decision. Each recall and action is receipted once. */
export function acksOwed(
  agent: AgentDecision,
  previouslySupervised: readonly RecallRow[],
  alreadyAcked: ReadonlySet<string>,
): AckIntent[] {
  const decisions = [agent.core, ...agent.tools.map((t) => t.decision)]
  const stops = new Map(decisions.flatMap((d) => d.activeStops).map((r) => [r.key, r]))
  const advisories = new Map(decisions.flatMap((d) => d.activeAdvisories).map((r) => [r.key, r]))

  const owed: AckIntent[] = []
  const add = (recall: RecallRow, action: AckAction) => {
    if (!alreadyAcked.has(ackId(recall.key, action))) owed.push({ recall, action })
  }
  for (const r of stops.values()) add(r, "BLOCKED")
  for (const r of advisories.values()) add(r, "SUPERVISED")
  const groups = [
    { files: agent.coreFiles, decision: agent.core },
    ...agent.tools.map((t) => ({ files: [t.file], decision: t.decision })),
  ]
  for (const r of previouslySupervised) {
    // A warning overtaken by a STOP on the same file has not cleared.
    const overtaken = groups.some((g) => g.decision.activeStops.length > 0 && g.files.some((f) => recallCovers(r, f)))
    if (!advisories.has(r.key) && !overtaken) add(r, "CLEARED")
  }
  return owed
}

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
