import type { AckAction, AckRow, Hex, LiftRow, PublicView, RecallRow } from "@ceasenet/core"

/**
 * Everything that moves on the live screen comes from here.
 *
 * Each event is a difference between two real readings from Arkiv.
 * Nothing is scheduled or made up, so if nothing happened, nothing moves.
 */

/**
 * Receipts that point at a STOP which is no longer on Arkiv, by recall.
 * This needs nobody's memory: the receipts are public, and so is the STOP's absence.
 */
/** Receipts that say an agent obeyed a STOP. Other receipts can outlive their recall for ordinary reasons. */
const RECEIPTS_OF_A_STOP: readonly AckAction[] = ["BLOCKED", "UPDATED"]

export function orphanReceipts(view: PublicView): Map<Hex, AckRow[]> {
  const live = new Set(view.recalls.map((r) => r.key))
  const orphans = new Map<Hex, AckRow[]>()
  for (const ack of view.acks) {
    if (live.has(ack.recall) || !RECEIPTS_OF_A_STOP.includes(ack.action)) continue
    orphans.set(ack.recall, [...(orphans.get(ack.recall) ?? []), ack])
  }
  return orphans
}

export type ViewEvent =
  | { kind: "recall"; row: RecallRow }
  | { kind: "receipt"; row: AckRow }
  | { kind: "lift"; row: LiftRow }
  | { kind: "confirmation" }
  | { kind: "disclosure" }
  | { kind: "erased"; recall: Hex; receipts: AckRow[] }

/**
 * Compares each reading of Arkiv with the one before. Whatever was already there when the page opened is
 * not news. A vanished STOP must be missing from two readings in a row, so one bad read cannot set it off.
 */
export class ViewTracker {
  private prev: PublicView | undefined
  private readonly seen = new Set<string>()
  private readonly announced = new Set<string>()

  /** Marks a STOP as already shown, when its deletion was confirmed some other way. */
  announce(recall: Hex): void {
    this.announced.add(recall)
  }

  next(view: PublicView): ViewEvent[] {
    const prev = this.prev
    this.prev = view
    const events: ViewEvent[] = []
    const isNew = (key: string) => {
      if (this.seen.has(key)) return false
      this.seen.add(key)
      return prev !== undefined
    }
    for (const row of view.recalls) if (isNew(row.key)) events.push({ kind: "recall", row })
    for (const row of view.acks) if (isNew(row.key)) events.push({ kind: "receipt", row })
    for (const row of view.lifts) if (isNew(row.key)) events.push({ kind: "lift", row })
    for (const row of view.endorsements) if (isNew(row.key)) events.push({ kind: "confirmation" })
    for (const row of view.disclosures) if (isNew(row.key)) events.push({ kind: "disclosure" })

    const orphans = orphanReceipts(view)
    if (!prev) {
      for (const recall of orphans.keys()) this.announced.add(recall)
      return events
    }
    const missingBefore = orphanReceipts(prev)
    for (const [recall, receipts] of orphans) {
      if (!missingBefore.has(recall) || this.announced.has(recall)) continue
      this.announced.add(recall)
      events.push({ kind: "erased", recall, receipts })
    }
    return events
  }
}

export type RecordKind = "STOP" | "WARNING" | "RECEIPT" | "FIX" | "LIFT" | "CONFIRM" | "DISPUTE" | "DISCLOSED" | "HEARTBEAT"

/** One real record on Arkiv, for the strip of blocks. */
export interface ChainRecord {
  id: string
  key: Hex
  block: bigint
  kind: RecordKind
  label: string
}

/** Every record the page can see, each with the block it landed in. */
export function recordsIn(view: PublicView, nameOf: (address: string) => string): ChainRecord[] {
  const records: ChainRecord[] = []
  const add = (key: Hex, block: bigint, kind: RecordKind, label: string, id: string = key) => records.push({ id, key, block, kind, label })
  for (const r of view.recalls) add(r.key, r.createdAt, r.level === "STOP" ? "STOP" : "WARNING", nameOf(r.creator))
  for (const a of view.acks) add(a.key, a.createdAt, "RECEIPT", `${nameOf(a.agent)} ${a.action}`)
  for (const l of view.lifts) add(l.key, l.createdAt, l.kind === "FIX" ? "FIX" : "LIFT", l.kind === "FIX" ? (l.fixedVersion ?? nameOf(l.creator)) : l.kind)
  for (const e of view.endorsements) add(e.key, e.createdAt, e.stance === "CONFIRM" ? "CONFIRM" : "DISPUTE", "one person")
  for (const d of view.disclosures) add(d.key, d.createdAt, "DISCLOSED", nameOf(d.creator))
  for (const { agent, heartbeat } of view.agents) {
    // The record stays the same and its update block moves, so each beat is its own entry.
    if (heartbeat) add(heartbeat.key, heartbeat.updatedAt, "HEARTBEAT", agent.name, `${heartbeat.key}:${heartbeat.updatedAt}`)
  }
  return records
}
