import { describe, expect, it } from "vitest"
import {
  acksOwed,
  ackId,
  countConfirmations,
  evaluate,
  type GateInput,
  makeTrust,
  recallContentHash,
  vanishedStops,
} from "../src/index"
import type { EndorseRow, Hex, LiftRow, RecallRow } from "../src/types"

const MAKER: Hex = "0x00000000000000000000000000000000000000aa"
const REGULATOR: Hex = "0x00000000000000000000000000000000000000bb"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000cc"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000dd"
const OTHER_MAKER: Hex = "0x00000000000000000000000000000000000000ee"

const H = "0xpolicy152"
const FIXED = "0xpolicy153"

const trust = makeTrust({
  stopKeys: [MAKER, REGULATOR, OTHER_MAKER],
  regulators: [REGULATOR],
  verifier: VERIFIER,
  threshold: 3,
  windowBlocks: 100n,
})

let n = 0
const k = (): Hex => `0x${(++n).toString(16).padStart(64, "0")}`

const stop = (over: Partial<RecallRow> = {}): RecallRow => ({
  key: k(),
  artifact: H,
  level: "STOP",
  severity: "HIGH",
  reason: "defect",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 10n,
  expiresAt: 10_000n,
  ...over,
})

const advisory = (over: Partial<RecallRow> = {}): RecallRow => stop({ level: "ADVISORY", creator: VERIFIER, ...over })

const endorse = (recall: Hex, human: string, over: Partial<EndorseRow> = {}): EndorseRow => ({
  key: k(),
  recall,
  stance: "CONFIRM",
  human,
  creator: VERIFIER,
  createdAt: 900n,
  ...over,
})

const lift = (recall: Hex, kind: LiftRow["kind"], creator: Hex, over: Partial<LiftRow> = {}): LiftRow => ({
  key: k(),
  recall,
  artifact: H,
  kind,
  creator,
  createdAt: 950n,
  ...over,
})

const input = (over: Partial<GateInput> = {}): GateInput => ({
  hashes: [H],
  rememberedStops: [],
  rememberedLifts: [],
  advisories: [],
  endorsements: [],
  currentBlock: 1000n,
  connectivity: { online: true, offlineForMs: 0 },
  lastSupervised: [],
  trust,
  timers: { graceMs: 1000, offlineSupervisedMs: 1000 },
  ...over,
})

describe("STOP", () => {
  it("runs when nothing applies", () => {
    expect(evaluate(input()).mode).toBe("RUNNING")
  })

  it("stops on a STOP from a trusted key", () => {
    expect(evaluate(input({ rememberedStops: [stop()] })).mode).toBe("STOPPED")
  })

  it("ignores a fake STOP created by an outsider", () => {
    expect(evaluate(input({ rememberedStops: [stop({ creator: OUTSIDER })] })).mode).toBe("RUNNING")
  })

  it("ignores a STOP for software this robot does not run", () => {
    expect(evaluate(input({ rememberedStops: [stop({ artifact: "0xother" })] })).mode).toBe("RUNNING")
  })

  it("matches creators and hashes regardless of case", () => {
    const s = stop({ creator: MAKER.toUpperCase().replace("0X", "0x") as Hex, artifact: H.toUpperCase() })
    expect(evaluate(input({ rememberedStops: [s] })).mode).toBe("STOPPED")
  })

  it("stays stopped after a fix if the robot still runs the old file", () => {
    const s = stop()
    const fix = lift(s.key, "FIX", MAKER, { fixedHash: FIXED })
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [fix] })).mode).toBe("STOPPED")
  })

  it("returns to work once the fixed file is installed", () => {
    const s = stop()
    const fix = lift(s.key, "FIX", MAKER, { fixedHash: FIXED })
    expect(evaluate(input({ hashes: [FIXED], rememberedStops: [s], rememberedLifts: [fix] })).mode).toBe("RUNNING")
  })

  it("resumes when the issuer withdraws the STOP", () => {
    const s = stop()
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", MAKER)] })).mode).toBe(
      "RUNNING",
    )
  })

  it("resumes when a regulator withdraws someone else's STOP", () => {
    const s = stop()
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", REGULATOR)] })).mode).toBe(
      "RUNNING",
    )
  })

  it("does not let an outsider withdraw a STOP", () => {
    const s = stop()
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", OUTSIDER)] })).mode).toBe(
      "STOPPED",
    )
  })

  it("does not let a different trusted maker withdraw another maker's STOP", () => {
    const s = stop()
    expect(
      evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", OTHER_MAKER)] })).mode,
    ).toBe("STOPPED")
  })

  it("does not let a maker withdraw a regulator's STOP", () => {
    const s = stop({ creator: REGULATOR })
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", MAKER)] })).mode).toBe(
      "STOPPED",
    )
  })

  it("keeps one STOP active when another on the same file is withdrawn", () => {
    const a = stop()
    const b = stop({ creator: REGULATOR })
    const d = evaluate(input({ rememberedStops: [a, b], rememberedLifts: [lift(a.key, "WITHDRAWN", MAKER)] }))
    expect(d.mode).toBe("STOPPED")
    expect(d.activeStops.map((r) => r.key)).toEqual([b.key])
  })

  it("beats a confirmed advisory", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    expect(evaluate(input({ rememberedStops: [stop()], advisories: [a], endorsements: ends })).mode).toBe("STOPPED")
  })
})

describe("SUPERVISED", () => {
  const confirmed = (over: Partial<GateInput> = {}) => {
    const a = advisory()
    return input({ advisories: [a], endorsements: ["h1", "h2", "h3"].map((h) => endorse(a.key, h)), ...over })
  }

  it("is reached at three fresh, distinct confirmations", () => {
    expect(evaluate(confirmed()).mode).toBe("SUPERVISED")
  })

  it("is not reached at two", () => {
    const a = advisory()
    const d = evaluate(input({ advisories: [a], endorsements: ["h1", "h2"].map((h) => endorse(a.key, h)) }))
    expect(d.mode).toBe("RUNNING")
  })

  it("counts one human only once", () => {
    const a = advisory()
    const d = evaluate(input({ advisories: [a], endorsements: ["h1", "h1", "h1"].map((h) => endorse(a.key, h)) }))
    expect(d.mode).toBe("RUNNING")
  })

  it("ignores confirmations not created by the verifier", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h, { creator: OUTSIDER }))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })

  it("ignores an advisory not created by the verifier", () => {
    const a = advisory({ creator: OUTSIDER })
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })

  it("ignores confirmations older than the window even if the record still exists", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h, { createdAt: 899n }))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })

  it("counts a confirmation exactly at the edge of the window", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h, { createdAt: 900n }))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("SUPERVISED")
  })

  it("requires confirmations to outnumber disputes", () => {
    const a = advisory()
    const ends = [
      ...["h1", "h2", "h3"].map((h) => endorse(a.key, h)),
      ...["d1", "d2", "d3"].map((h) => endorse(a.key, h, { stance: "DISPUTE" })),
    ]
    const r = countConfirmations(a, ends, 1000n, trust)
    expect(r).toEqual({ confirms: 3, disputes: 3, effective: 0 })
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })

  it("ends when a regulator dismisses the advisory", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    expect(
      evaluate(input({ advisories: [a], endorsements: ends, rememberedLifts: [lift(a.key, "DISMISSED", REGULATOR)] }))
        .mode,
    ).toBe("RUNNING")
  })

  it("does not let a maker dismiss an advisory about its own software", () => {
    const a = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    expect(
      evaluate(input({ advisories: [a], endorsements: ends, rememberedLifts: [lift(a.key, "DISMISSED", MAKER)] })).mode,
    ).toBe("SUPERVISED")
  })

  it("ignores confirmations meant for a different advisory", () => {
    const a = advisory()
    const b = advisory()
    const ends = ["h1", "h2", "h3"].map((h) => endorse(b.key, h))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })

  it("ignores an advisory on software this robot does not run", () => {
    const a = advisory({ artifact: "0xother" })
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    expect(evaluate(input({ advisories: [a], endorsements: ends })).mode).toBe("RUNNING")
  })
})

describe("losing Arkiv", () => {
  const offline = (ms: number) => ({ connectivity: { online: false, offlineForMs: ms } })

  it("keeps working during the grace period", () => {
    expect(evaluate(input(offline(500))).mode).toBe("RUNNING")
  })

  it("goes supervised after the grace period", () => {
    expect(evaluate(input(offline(1000))).mode).toBe("SUPERVISED")
  })

  it("stops after the supervised period", () => {
    expect(evaluate(input(offline(2000))).mode).toBe("STOPPED")
  })

  it("never restarts a stopped robot during the grace period", () => {
    expect(evaluate(input({ rememberedStops: [stop()], ...offline(1) })).mode).toBe("STOPPED")
  })

  it("stays supervised during the grace period if it was already supervised", () => {
    expect(evaluate(input({ lastSupervised: [advisory()], ...offline(1) })).mode).toBe("SUPERVISED")
  })

  it("still stops after the offline limit if it was supervised", () => {
    expect(evaluate(input({ lastSupervised: [advisory()], ...offline(5000) })).mode).toBe("STOPPED")
  })

  it("honours a withdrawal it saw before going offline", () => {
    const s = stop()
    expect(
      evaluate(input({ rememberedStops: [s], rememberedLifts: [lift(s.key, "WITHDRAWN", MAKER)], ...offline(1) })).mode,
    ).toBe("RUNNING")
  })
})

describe("deleted STOPs", () => {
  it("stay in force, because a STOP that disappears is not a lift", () => {
    const s = stop()
    // The STOP is no longer on Arkiv, but the gate remembers it.
    expect(evaluate(input({ rememberedStops: [s] })).mode).toBe("STOPPED")
    expect(vanishedStops([s], [], [], trust).map((r) => r.key)).toEqual([s.key])
  })

  it("are not reported as vanished once properly withdrawn", () => {
    const s = stop()
    expect(vanishedStops([s], [], [lift(s.key, "WITHDRAWN", MAKER)], trust)).toEqual([])
  })

  it("are not reported as vanished while still on Arkiv", () => {
    const s = stop()
    expect(vanishedStops([s], [s], [], trust)).toEqual([])
  })
})

describe("receipts", () => {
  it("are owed once for a STOP", () => {
    const s = stop()
    const d = evaluate(input({ rememberedStops: [s] }))
    expect(acksOwed(d, [], new Set()).map((a) => a.action)).toEqual(["STOPPED"])
    expect(acksOwed(d, [], new Set([ackId(s.key, "STOPPED")]))).toEqual([])
  })

  it("record leaving slow mode", () => {
    const a = advisory()
    const d = evaluate(input())
    expect(acksOwed(d, [a], new Set()).map((x) => x.action)).toEqual(["LEFT_SLOW"])
  })

  it("do not record leaving slow mode when a STOP takes over", () => {
    const a = advisory()
    const d = evaluate(input({ rememberedStops: [stop()] }))
    expect(acksOwed(d, [a], new Set()).map((x) => x.action)).toEqual(["STOPPED"])
  })
})

describe("content hash", () => {
  it("is stable and ignores address case", () => {
    const c = { artifact: "0xAB", level: "STOP", severity: "HIGH", reason: "r" }
    expect(recallContentHash(c)).toBe(recallContentHash({ ...c, artifact: "0xab" }))
  })

  it("changes when the content changes", () => {
    const c = { artifact: "0xab", level: "STOP", severity: "HIGH", reason: "r" }
    expect(recallContentHash(c)).not.toBe(recallContentHash({ ...c, reason: "other" }))
  })
})
