import { lower } from "./gate"
import type { AckRow, HeartbeatRow, Hex, LoadoutRow, RecallRow, RobotRow } from "./types"

/**
 * Where a robot stands on one recall.
 *
 * "Silent" and "no receipt" are kept apart on purpose. A silent robot may have lost its internet or may be
 * ignoring the recall: nobody can tell, so the board never claims which.
 */
export type RobotRecallState =
  | "FIXED" // runs the fixed software and has said so
  | "STOPPED" // has receipted the STOP and still runs the recalled file
  | "SLOWED" // has receipted a confirmed advisory
  | "SILENT" // runs the recalled file, no receipt, no live heartbeat
  | "NO_RECEIPT" // runs the recalled file, no receipt, but its heartbeat is alive

export interface BoardRobot {
  robot: RobotRow
  loadout?: LoadoutRow
  heartbeat?: HeartbeatRow
}

export interface BoardRow extends BoardRobot {
  state: RobotRecallState
  receipts: AckRow[]
}

export interface RecallBoard {
  rows: BoardRow[]
  /** Robots that have acted on this recall. */
  obeyed: number
  silent: number
  noReceipt: number
  affected: number
}

const runsFile = (loadout: LoadoutRow | undefined, hash: string) =>
  loadout?.files.some((f) => lower(f.hash) === lower(hash)) ?? false

/** A receipt counts only if the robot it names created it, so nobody can obey on a robot's behalf. */
export function genuineReceipts(acks: readonly AckRow[], recall: Hex, robot: Hex): AckRow[] {
  return acks.filter(
    (a) => a.recall === recall && lower(a.robot) === lower(robot) && lower(a.creator) === lower(robot),
  )
}

/**
 * Who is affected by a recall and whether they obeyed.
 *
 * It starts from every registered robot's loadout, not from the receipts. Starting from receipts would
 * leave out exactly the robots that matter most: the ones that never answered.
 */
export function buildRecallBoard(recall: RecallRow, robots: readonly BoardRobot[], acks: readonly AckRow[]): RecallBoard {
  const rows: BoardRow[] = []
  for (const entry of robots) {
    const receipts = genuineReceipts(acks, recall.key, entry.robot.robot)
    const running = runsFile(entry.loadout, recall.artifact)
    if (!running && receipts.length === 0) continue

    let state: RobotRecallState
    if (!running && receipts.some((r) => r.action === "UPDATED")) state = "FIXED"
    else if (receipts.some((r) => r.action === "STOPPED")) state = "STOPPED"
    else if (receipts.some((r) => r.action === "SLOWED")) state = "SLOWED"
    else state = entry.heartbeat ? "NO_RECEIPT" : "SILENT"
    rows.push({ ...entry, state, receipts })
  }
  rows.sort((a, b) => a.robot.serial.localeCompare(b.robot.serial))
  const count = (...states: RobotRecallState[]) => rows.filter((r) => states.includes(r.state)).length
  return {
    rows,
    obeyed: count("FIXED", "STOPPED", "SLOWED"),
    silent: count("SILENT"),
    noReceipt: count("NO_RECEIPT"),
    affected: rows.length,
  }
}

/**
 * STOPs that robots have receipted but that no longer exist on Arkiv.
 *
 * The network serves no history, so this is the lasting proof that a deleted STOP existed: the receipts,
 * created by the robots and out of the issuer's reach, carry its content hash and its issuer.
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
    if (live.has(a.recall) || a.action !== "STOPPED") continue
    if (lower(a.creator) !== lower(a.robot)) continue
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

export type PlateColour = "green" | "amber" | "red" | "grey"

/** The colour on a robot's QR plate. Anything other than a live heartbeat from its own key is grey. */
export function plateColour(robot: Hex, heartbeat: HeartbeatRow | undefined): PlateColour {
  if (!heartbeat || lower(heartbeat.creator) !== lower(robot)) return "grey"
  if (heartbeat.mode === "RUNNING") return "green"
  if (heartbeat.mode === "STOPPED") return "red"
  return "amber"
}
