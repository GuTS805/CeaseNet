import { describe, expect, it } from "vitest"
import {
  acksOwed,
  ackId,
  countConfirmations,
  evaluate,
  evaluateAgent,
  type GateInput,
  makeTrust,
  recallContentHash,
  recallCovers,
  vanishedStops,
  verdictFor,
} from "../src/index"
import type { EndorseRow, Hex, LiftRow, LoadedFile, RecallRow } from "../src/types"

const MAKER: Hex = "0x00000000000000000000000000000000000000aa"
const REGULATOR: Hex = "0x00000000000000000000000000000000000000bb"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000cc"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000dd"
const OTHER_MAKER: Hex = "0x00000000000000000000000000000000000000ee"

const H = "0xpolicy152"
const FIXED = "0xpolicy153"

const file = (hash: string, over: Partial<LoadedFile> = {}): LoadedFile => ({
  kind: "tool",
  name: "demo-mail-tool",
  version: "1.0.16",
  hash,
  ...over,
})

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
  files: [file(H)],
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

  it("ignores a STOP for software this agent does not load", () => {
    expect(evaluate(input({ rememberedStops: [stop({ artifact: "0xother" })] })).mode).toBe("RUNNING")
  })

  it("matches creators and hashes regardless of case", () => {
    const s = stop({ creator: MAKER.toUpperCase().replace("0X", "0x") as Hex, artifact: H.toUpperCase() })
    expect(evaluate(input({ rememberedStops: [s] })).mode).toBe("STOPPED")
  })

  it("stays stopped after a fix if the agent still loads the old file", () => {
    const s = stop()
    const fix = lift(s.key, "FIX", MAKER, { fixedHash: FIXED })
    expect(evaluate(input({ rememberedStops: [s], rememberedLifts: [fix] })).mode).toBe("STOPPED")
  })

  it("allows it once the fixed file is loaded", () => {
    const s = stop()
    const fix = lift(s.key, "FIX", MAKER, { fixedHash: FIXED })
    expect(evaluate(input({ files: [file(FIXED)], rememberedStops: [s], rememberedLifts: [fix] })).mode).toBe("RUNNING")
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

  it("ignores an advisory on software this agent does not load", () => {
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

  it("never brings back something stopped during the grace period", () => {
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
  const agent = (over: Partial<GateInput> = {}) => evaluateAgent(input(over))

  it("are owed once for a STOP", () => {
    const s = stop()
    const d = agent({ rememberedStops: [s] })
    expect(acksOwed(d, [], new Set()).map((a) => a.action)).toEqual(["BLOCKED"])
    expect(acksOwed(d, [], new Set([ackId(s.key, "BLOCKED")]))).toEqual([])
  })

  it("are owed once when one STOP covers two loaded tools", () => {
    const s = stop({ pkg: "demo-mail-tool", versions: "*" })
    const d = agent({ rememberedStops: [s], files: [file("0xa"), file("0xb")] })
    expect(acksOwed(d, [], new Set())).toHaveLength(1)
  })

  it("record a warning clearing", () => {
    const a = advisory()
    expect(acksOwed(agent(), [a], new Set()).map((x) => x.action)).toEqual(["CLEARED"])
  })

  it("do not record a warning clearing when a STOP takes over on the same file", () => {
    const a = advisory()
    const d = agent({ rememberedStops: [stop()] })
    expect(acksOwed(d, [a], new Set()).map((x) => x.action)).toEqual(["BLOCKED"])
  })

  it("record a warning clearing even while a different tool is under a STOP", () => {
    const warned = advisory({ artifact: "0xfiles" })
    const s = stop({ artifact: "0xmail" })
    const d = agent({ rememberedStops: [s], files: [file("0xmail"), file("0xfiles", { name: "demo-files-tool" })] })
    expect(acksOwed(d, [warned], new Set()).map((x) => x.action).sort()).toEqual(["BLOCKED", "CLEARED"])
  })
})

describe("what a recall covers", () => {
  const range = (versions: string, pkg = "demo-mail-tool") => stop({ artifact: "0xother", pkg, versions })

  it("matches an exact hash whatever the name says", () => {
    expect(recallCovers(stop({ artifact: "0xABC" }), file("0xabc", { name: "renamed-copy" }))).toBe(true)
  })

  it("matches a package and version range", () => {
    expect(recallCovers(range(">=1.0.16 <1.0.17"), file("0x1", { version: "1.0.16" }))).toBe(true)
    expect(recallCovers(range(">=1.0.16 <1.0.17"), file("0x1", { version: "1.0.17" }))).toBe(false)
    expect(recallCovers(range(">=1.0.16 <1.0.17"), file("0x1", { version: "1.0.15" }))).toBe(false)
  })

  it("does not match a different package", () => {
    expect(recallCovers(range("*", "other-tool"), file("0x1"))).toBe(false)
  })

  it("covers nothing when the range cannot be read", () => {
    expect(recallCovers(range("not a range"), file("0x1"))).toBe(false)
  })

  it("covers nothing by range when the loaded version cannot be read", () => {
    expect(recallCovers(range("*"), file("0x1", { version: "latest" }))).toBe(false)
  })

  it("needs both a name and a range", () => {
    expect(recallCovers(stop({ artifact: "0xother", pkg: "demo-mail-tool" }), file("0x1"))).toBe(false)
  })
})

describe("one bad tool", () => {
  const MAIL = file("0xmail")
  const FILES = file("0xfiles", { name: "demo-files-tool", version: "2.1.0" })
  const MODEL = file("0xmodel", { kind: "model", name: "glm" })
  const files = [MAIL, FILES, MODEL]

  it("blocks only that tool and leaves the agent working", () => {
    const d = evaluateAgent(input({ files, rememberedStops: [stop({ artifact: "0xmail" })] }))
    expect(d.core.mode).toBe("RUNNING")
    expect(verdictFor(d, "0xmail")).toBe("BLOCK")
    expect(verdictFor(d, "0xfiles")).toBe("ALLOW")
  })

  it("asks a human for a tool with a confirmed warning, and only for that tool", () => {
    const a = advisory({ artifact: "0xmail" })
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    const d = evaluateAgent(input({ files, advisories: [a], endorsements: ends }))
    expect(verdictFor(d, "0xmail")).toBe("NEEDS_APPROVAL")
    expect(verdictFor(d, "0xfiles")).toBe("ALLOW")
  })

  it("stops every tool when the agent's model is recalled", () => {
    const d = evaluateAgent(input({ files, rememberedStops: [stop({ artifact: "0xmodel" })] }))
    expect(d.core.mode).toBe("STOPPED")
    expect(verdictFor(d, "0xfiles")).toBe("BLOCK")
  })

  it("asks a human for every tool when the agent's prompt has a confirmed warning", () => {
    const a = advisory({ artifact: "0xmodel" })
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    const d = evaluateAgent(input({ files, advisories: [a], endorsements: ends }))
    expect(verdictFor(d, "0xfiles")).toBe("NEEDS_APPROVAL")
  })

  it("lets the stricter state win when a tool is blocked and the agent is supervised", () => {
    const a = advisory({ artifact: "0xmodel" })
    const ends = ["h1", "h2", "h3"].map((h) => endorse(a.key, h))
    const d = evaluateAgent(
      input({ files, advisories: [a], endorsements: ends, rememberedStops: [stop({ artifact: "0xmail" })] }),
    )
    expect(verdictFor(d, "0xmail")).toBe("BLOCK")
  })

  it("does not let an unknown tool through", () => {
    const d = evaluateAgent(input({ files }))
    expect(verdictFor(d, "0xnever-measured")).toBe("BLOCK")
  })

  it("applies the offline steps to every tool", () => {
    const offline = (offlineForMs: number) => ({ connectivity: { online: false, offlineForMs } })
    const at = (ms: number) => evaluateAgent(input({ files, ...offline(ms) }))
    expect(verdictFor(at(10), "0xmail")).toBe("ALLOW")
    expect(verdictFor(at(1000), "0xmail")).toBe("NEEDS_APPROVAL")
    expect(verdictFor(at(2000), "0xfiles")).toBe("BLOCK")
  })

  it("keeps a warning applying only to its own tool while offline", () => {
    const a = advisory({ artifact: "0xmail" })
    const d = evaluateAgent(input({ files, lastSupervised: [a], connectivity: { online: false, offlineForMs: 5 } }))
    expect(verdictFor(d, "0xmail")).toBe("NEEDS_APPROVAL")
    expect(verdictFor(d, "0xfiles")).toBe("ALLOW")
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
