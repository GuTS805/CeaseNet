import { lower, recallCovers } from "./gate"
import type { AckRow, AgentRow, HeartbeatRow, Hex, LoadoutRow, RecallRow, TrustPolicy } from "./types"

/**
 * Where an agent stands on one recall.
 *
 * "Silent" and "no receipt" are kept apart on purpose. A silent agent may have lost its internet or may be
 * ignoring the recall: nobody can tell, so the board never claims which.
 */
export type AgentRecallState =
  | "FIXED" // runs the fixed version and has said so
  | "BLOCKED" // has receipted the STOP and refuses to use the file
  | "SUPERVISED" // has receipted a confirmed warning and asks a human first
  | "SILENT" // loads the recalled file, no receipt, no live heartbeat
  | "NO_RECEIPT" // loads the recalled file, no receipt, but its heartbeat is alive
  | "NOT_FOLLOWING" // its owner has chosen not to obey this issuer

export interface BoardAgent {
  agent: AgentRow
  loadout?: LoadoutRow
  heartbeat?: HeartbeatRow
  /** The owner's public trust list. */
  policy?: TrustPolicy
}

export interface BoardRow extends BoardAgent {
  state: AgentRecallState
  receipts: AckRow[]
}

export interface RecallBoard {
  rows: BoardRow[]
  /** Agents that have acted on this recall. */
  obeyed: number
  silent: number
  noReceipt: number
  notFollowing: number
  /** Agents whose owners follow this issuer and that load the file or have receipted it. */
  affected: number
}

const loadsFile = (loadout: LoadoutRow | undefined, recall: RecallRow) =>
  loadout?.files.some((f) => recallCovers(recall, f)) ?? false

/** A receipt counts only if the agent it names created it, so nobody can obey on an agent's behalf. */
export function genuineReceipts(acks: readonly AckRow[], recall: Hex, agent: Hex): AckRow[] {
  return acks.filter(
    (a) => a.recall === recall && lower(a.agent) === lower(agent) && lower(a.creator) === lower(agent),
  )
}

export function follows(policy: TrustPolicy | undefined, recall: RecallRow): boolean {
  if (!policy) return true
  return recall.level === "STOP"
    ? policy.issuers.some((i) => lower(i) === lower(recall.creator))
    : lower(policy.verifier) === lower(recall.creator)
}

/** How many owners have chosen, on their public list, to obey this recall's issuer. Anyone can issue a recall: this is what makes one matter. */
export function followersOf(recall: RecallRow, agents: readonly BoardAgent[]): number {
  const owners = new Set(agents.filter((a) => a.policy && follows(a.policy, recall)).map((a) => lower(a.agent.owner)))
  return owners.size
}

/**
 * Who is affected by a recall and whether they obeyed.
 *
 * It starts from every registered agent's loadout, not from the receipts. Starting from receipts would
 * leave out exactly the agents that matter most: the ones that never answered.
 */
export function buildRecallBoard(recall: RecallRow, agents: readonly BoardAgent[], acks: readonly AckRow[]): RecallBoard {
  const rows: BoardRow[] = []
  for (const entry of agents) {
    const receipts = genuineReceipts(acks, recall.key, entry.agent.agent)
    const loaded = loadsFile(entry.loadout, recall)
    if (!loaded && receipts.length === 0) continue

    let state: AgentRecallState
    if (!loaded && receipts.some((r) => r.action === "UPDATED")) state = "FIXED"
    else if (!follows(entry.policy, recall)) state = "NOT_FOLLOWING"
    else if (receipts.some((r) => r.action === "BLOCKED")) state = "BLOCKED"
    else if (receipts.some((r) => r.action === "SUPERVISED")) state = "SUPERVISED"
    else state = entry.heartbeat ? "NO_RECEIPT" : "SILENT"
    rows.push({ ...entry, state, receipts })
  }
  rows.sort((a, b) => a.agent.name.localeCompare(b.agent.name))
  const count = (...states: AgentRecallState[]) => rows.filter((r) => states.includes(r.state)).length
  const notFollowing = count("NOT_FOLLOWING")
  return {
    rows,
    obeyed: count("FIXED", "BLOCKED", "SUPERVISED"),
    silent: count("SILENT"),
    noReceipt: count("NO_RECEIPT"),
    notFollowing,
    affected: rows.length - notFollowing,
  }
}

/**
 * STOPs that agents have receipted but that no longer exist on Arkiv.
 *
 * The network serves no history, so this is the lasting proof that a deleted STOP existed: the receipts,
 * created by the agents and out of the issuer's reach, carry its content hash and its issuer.
 */
export function deletedStops(acks: readonly AckRow[], liveRecalls: readonly RecallRow[]): {
  recall: Hex
  recallHash: string
  issuer: Hex
  artifact: string
  receipts: AckRow[]
}[] {
  const live = new Set(liveRecalls.map((r) => r.key))
  const byRecall = new Map<Hex, AckRow[]>()
  for (const a of acks) {
    if (live.has(a.recall) || a.action !== "BLOCKED") continue
    if (lower(a.creator) !== lower(a.agent)) continue
    byRecall.set(a.recall, [...(byRecall.get(a.recall) ?? []), a])
  }
  return [...byRecall.entries()].map(([recall, receipts]) => ({
    recall,
    recallHash: receipts[0]!.recallHash,
    issuer: receipts[0]!.issuer,
    artifact: receipts[0]!.artifact,
    receipts,
  }))
}

/** Whether an agent is reporting right now. A heartbeat expires by itself, so an agent that has gone away stops being live with nothing to clean up. */
export const isLive = (entry: BoardAgent): boolean => statusColourOf(entry.agent.agent, entry.heartbeat) !== "grey"

export type StatusColour = "green" | "amber" | "red" | "grey"

/** The colour of an agent's status. Anything other than a live heartbeat from its own key is grey. */
export function statusColourOf(agent: Hex, heartbeat: HeartbeatRow | undefined): StatusColour {
  if (!heartbeat || lower(heartbeat.creator) !== lower(agent)) return "grey"
  if (heartbeat.mode === "RUNNING") return "green"
  if (heartbeat.mode === "STOPPED") return "red"
  return "amber"
}
