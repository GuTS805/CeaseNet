import { describe, expect, it } from "vitest"
import type { AckRow, Hex, LiftRow, PublicView, RecallRow } from "@ceasenet/core"
import { orphanReceipts, recordsIn, ViewTracker } from "../src/warroom/events"

const BAD = "0xbad"

const view = (over: Partial<PublicView> = {}): PublicView => ({
  block: 100n,
  agents: [],
  recalls: [],
  acks: [],
  lifts: [],
  endorsements: [],
  artifacts: [],
  disclosures: [],
  ...over,
})

const stop = (key: Hex = "0xs1"): RecallRow =>
  ({ key, artifact: BAD, level: "STOP", severity: "CRITICAL", reason: "r", contentHash: "0xh", creator: "0xm", createdAt: 90n, expiresAt: 999n }) as RecallRow

const ack = (key: Hex, recall: Hex = "0xs1", action: AckRow["action"] = "BLOCKED"): AckRow =>
  ({ key, recall, recallHash: "0xh", agent: "0xa1", artifact: BAD, action, issuer: "0xm", creator: "0xa1", createdAt: 95n }) as AckRow

describe("events from Arkiv", () => {
  it("does not replay what was already there when the page opened", () => {
    expect(new ViewTracker().next(view({ recalls: [stop()], acks: [ack("0xk1")] }))).toEqual([])
  })

  it("reports each new record once", () => {
    const t = new ViewTracker()
    t.next(view())
    const fix = { key: "0xl1", kind: "FIX", createdAt: 96n } as unknown as LiftRow
    const first = t.next(view({ recalls: [stop()], acks: [ack("0xk1")], lifts: [fix] }))
    expect(first.map((e) => e.kind)).toEqual(["recall", "receipt", "lift"])
    expect(t.next(view({ recalls: [stop()], acks: [ack("0xk1")], lifts: [fix] }))).toEqual([])
  })

  it("finds receipts that point at a STOP no longer on the record", () => {
    expect([...orphanReceipts(view({ recalls: [stop()], acks: [ack("0xk1")] })).keys()]).toEqual([])
    expect(orphanReceipts(view({ acks: [ack("0xk1"), ack("0xk2")] })).get("0xs1")).toHaveLength(2)
  })

  it("does not count a warning's receipts as a vanished STOP", () => {
    expect(orphanReceipts(view({ acks: [ack("0xk1", "0xw1", "SUPERVISED"), ack("0xk2", "0xw1", "CLEARED")] })).size).toBe(0)
  })

  it("needs two readings in a row before saying a STOP was erased", () => {
    const t = new ViewTracker()
    const receipts = [ack("0xk1")]
    t.next(view({ recalls: [stop()], acks: receipts }))
    expect(t.next(view({ acks: receipts })).filter((e) => e.kind === "erased")).toEqual([])
    expect(t.next(view({ acks: receipts })).filter((e) => e.kind === "erased")).toEqual([{ kind: "erased", recall: "0xs1", receipts }])
  })

  it("ignores one bad reading, and does not repeat itself", () => {
    const t = new ViewTracker()
    const receipts = [ack("0xk1")]
    t.next(view({ recalls: [stop()], acks: receipts }))
    t.next(view({ acks: receipts }))
    expect(t.next(view({ recalls: [stop()], acks: receipts }))).toEqual([])
    t.next(view({ acks: receipts }))
    expect(t.next(view({ acks: receipts })).filter((e) => e.kind === "erased")).toHaveLength(1)
    expect(t.next(view({ acks: receipts })).filter((e) => e.kind === "erased")).toEqual([])
  })

  it("does not announce an old deletion when the page opens, or one already shown", () => {
    const receipts = [ack("0xk1")]
    const opened = new ViewTracker()
    opened.next(view({ acks: receipts }))
    expect(opened.next(view({ acks: receipts }))).toEqual([])

    const shown = new ViewTracker()
    shown.next(view({ recalls: [stop()], acks: receipts }))
    shown.announce("0xs1")
    shown.next(view({ acks: receipts }))
    expect(shown.next(view({ acks: receipts }))).toEqual([])
  })
})

describe("the strip of blocks", () => {
  it("puts each record in the block it landed in", () => {
    const records = recordsIn(view({ recalls: [stop()], acks: [ack("0xk1")] }), (a) => (a === "0xa1" ? "Asha Exports" : "Maker"))
    expect(records).toEqual([
      { id: "0xs1", key: "0xs1", block: 90n, kind: "STOP", label: "Maker" },
      { id: "0xk1", key: "0xk1", block: 95n, kind: "RECEIPT", label: "Asha Exports BLOCKED" },
    ])
  })

  it("counts each heartbeat separately, since one record is updated again and again", () => {
    const beat = (updatedAt: bigint) =>
      recordsIn(
        view({
          agents: [{ agent: { name: "Asha Exports" }, heartbeat: { key: "0xh1", updatedAt } } as unknown as PublicView["agents"][number]],
        }),
        (a) => a,
      )[0]
    expect(beat(10n)?.id).not.toBe(beat(14n)?.id)
    expect(beat(14n)).toMatchObject({ kind: "HEARTBEAT", block: 14n, label: "Asha Exports" })
  })
})
