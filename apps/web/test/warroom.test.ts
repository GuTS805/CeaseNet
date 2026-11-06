import { describe, expect, it } from "vitest"
import type { AckRow, Hex, LiftRow, PublicView, RecallRow } from "@ceasenet/core"
import type { DemoAgent, DemoState } from "../src/lib"
import { everyoneObeyed, mailLine, orphanReceipts, recordsIn, StateTracker, ViewTracker } from "../src/warroom/events"

const BAD = "0xbad"
const GOOD = "0x900d"
const FILES = "0xf11e"

const file = (hash: string, name = "demo-mail-tool", version = "1.0.16") => ({ kind: "tool", name, version, hash })

const agent = (over: Partial<DemoAgent> = {}): DemoAgent =>
  ({
    id: "a",
    company: "Asha Exports",
    address: "0xa1" as Hex,
    owner: "0xb1" as Hex,
    status: "RUNNING",
    online: true,
    tools: [
      { file: file(BAD), verdict: "ALLOW" },
      { file: file(FILES, "demo-files-tool", "2.1.0"), verdict: "ALLOW" },
    ],
    followsMaker: true,
    jobs: 0,
    sent: 0,
    stolen: 0,
    drafts: 0,
    feed: [],
    fixAvailable: false,
    vanished: [],
    diary: { entries: 0, waiting: 0, parts: [] },
    ...over,
  }) as DemoAgent

const state = (...agents: DemoAgent[]): DemoState =>
  ({
    brainSource: "model",
    model: "m",
    timers: { checkIntervalMs: 2000 },
    idle: false,
    stolenMail: [],
    tools: { bad: file(BAD), fixed: file(GOOD, "demo-mail-tool", "1.0.17"), files: file(FILES) },
    swarm: { on: false, evidenceReady: false },
    worldIdApprovals: false,
    agents,
  }) as DemoState

const blocked = () => [
  { file: file(BAD), verdict: "BLOCK" as const },
  { file: file(FILES, "demo-files-tool", "2.1.0"), verdict: "ALLOW" as const },
]

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

describe("what the mail line shows", () => {
  it("follows the guard's own verdict", () => {
    expect(mailLine(agent(), BAD)).toBe("leaking")
    expect(mailLine(agent({ tools: [{ file: file(BAD), verdict: "NEEDS_APPROVAL" }] }), BAD)).toBe("asks")
    expect(mailLine(agent({ tools: blocked() }), BAD)).toBe("cut")
  })

  it("is fixed only when the bad version is gone", () => {
    expect(mailLine(agent({ tools: [{ file: file(GOOD, "demo-mail-tool", "1.0.17"), verdict: "ALLOW" }] }), BAD)).toBe("fixed")
  })

  it("does not care about the letter case of a hash", () => {
    expect(mailLine(agent({ tools: [{ file: file("0xBAD"), verdict: "BLOCK" }] }), BAD)).toBe("cut")
  })
})

describe("when everyone has obeyed", () => {
  it("waits for every connected follower", () => {
    expect(everyoneObeyed(state(agent({ id: "a", tools: blocked() }), agent({ id: "b" })))).toBe(false)
    expect(everyoneObeyed(state(agent({ id: "a", tools: blocked() }), agent({ id: "b", tools: blocked() })))).toBe(true)
  })

  it("does not wait for an agent that is cut off, or whose owner does not follow the maker", () => {
    expect(everyoneObeyed(state(agent({ id: "a", tools: blocked() }), agent({ id: "b", online: false }), agent({ id: "c", followsMaker: false })))).toBe(true)
  })

  it("is never true when nobody could obey", () => {
    expect(everyoneObeyed(state(agent({ online: false, tools: blocked() })))).toBe(false)
  })
})

describe("events from the demo server", () => {
  it("treats the first reading as a starting point, not as news", () => {
    expect(new StateTracker().next(state(agent({ sent: 9, stolen: 9, tools: blocked() })))).toEqual([])
  })

  it("reports nothing when nothing changed", () => {
    const t = new StateTracker()
    t.next(state(agent({ sent: 1, stolen: 1 })))
    expect(t.next(state(agent({ sent: 1, stolen: 1 })))).toEqual([])
  })

  it("reports an email and the stolen copy only when their files grew", () => {
    const t = new StateTracker()
    t.next(state(agent()))
    expect(t.next(state(agent({ sent: 1, stolen: 1 })))).toEqual([
      { kind: "email", agent: "a" },
      { kind: "leak", agent: "a" },
    ])
  })

  it("reports an email with no stolen copy after the fix", () => {
    const fixed = [{ file: file(GOOD, "demo-mail-tool", "1.0.17"), verdict: "ALLOW" as const }]
    const t = new StateTracker()
    t.next(state(agent({ tools: fixed, sent: 5, stolen: 3 })))
    expect(t.next(state(agent({ tools: fixed, sent: 6, stolen: 3 })))).toEqual([{ kind: "email", agent: "a" }])
  })

  it("snaps once, at the moment the guard blocks the tool", () => {
    const t = new StateTracker()
    t.next(state(agent()))
    expect(t.next(state(agent({ tools: blocked() })))).toEqual([{ kind: "snap", agent: "a" }])
    expect(t.next(state(agent({ tools: blocked() })))).toEqual([])
  })

  it("reports each refused call it has not seen, once", () => {
    const line = (id: number) => ({ id, at: 1, kind: "blocked" as const, text: "BLOCKED send_email" })
    const t = new StateTracker()
    t.next(state(agent({ tools: blocked(), feed: [line(1)] })))
    expect(t.next(state(agent({ tools: blocked(), feed: [line(1), line(2)] })))).toEqual([{ kind: "refused", agent: "a" }])
    expect(t.next(state(agent({ tools: blocked(), feed: [line(1), line(2)] })))).toEqual([])
  })

  it("reports the move to the fix, and a draft", () => {
    const t = new StateTracker()
    t.next(state(agent({ tools: blocked() })))
    expect(t.next(state(agent({ tools: [{ file: file(GOOD, "demo-mail-tool", "1.0.17"), verdict: "ALLOW" }], drafts: 1 })))).toEqual([
      { kind: "draft", agent: "a" },
      { kind: "moved", agent: "a" },
    ])
  })

  it("reports when a human has to approve each call", () => {
    const t = new StateTracker()
    t.next(state(agent()))
    expect(t.next(state(agent({ tools: [{ file: file(BAD), verdict: "NEEDS_APPROVAL" }] })))).toEqual([{ kind: "asks", agent: "a" }])
  })
})

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
