import { describe, expect, it } from "vitest"
import {
  decodeMemory,
  encodeMemory,
  GateRunner,
  type GateView,
  makeTrust,
  memoryStore,
} from "../src/index"
import type { Hex, LiftRow, RecallRow } from "../src/types"

const MAKER: Hex = "0x00000000000000000000000000000000000000aa"
const REGULATOR: Hex = "0x00000000000000000000000000000000000000bb"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000cc"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000dd"
const H = "0xabc"
const FIXED = "0xdef"

const trust = makeTrust({
  stopKeys: [MAKER, REGULATOR],
  regulators: [REGULATOR],
  verifier: VERIFIER,
  threshold: 3,
  windowBlocks: 1000n,
})

const STOP: RecallRow = {
  key: "0x01",
  artifact: H,
  level: "STOP",
  severity: "HIGH",
  reason: "r",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 5n,
  expiresAt: 7_000_000n,
}

const FIX: LiftRow = {
  key: "0x02",
  recall: "0x01",
  artifact: H,
  kind: "FIX",
  fixedHash: FIXED,
  creator: MAKER,
  createdAt: 8n,
}

const view = (over: Partial<GateView> = {}): GateView => ({
  block: 10n,
  stops: [],
  advisories: [],
  endorsements: [],
  lifts: [],
  ...over,
})

const make = (store = memoryStore()) => {
  const clock = { t: 0 }
  const runner = new GateRunner({
    trust,
    timers: { graceMs: 1000, offlineSupervisedMs: 1000 },
    store,
    now: () => clock.t,
  })
  return { runner, clock, store }
}

const fail = async (): Promise<GateView> => {
  throw new Error("no network")
}

describe("GateRunner", () => {
  it("stops, owes one receipt, and stops owing it once sent", async () => {
    const { runner } = make()
    const first = await runner.check([H], async () => view({ stops: [STOP] }))
    expect(first.decision.mode).toBe("STOPPED")
    expect(first.acks.map((a) => a.action)).toEqual(["STOPPED"])
    runner.markAcked(STOP.key, "STOPPED")
    const second = await runner.check([H], async () => view({ stops: [STOP] }))
    expect(second.acks).toEqual([])
  })

  it("does not remember a fake STOP", async () => {
    const { runner } = make()
    const fake = { ...STOP, key: "0x09" as Hex, creator: OUTSIDER }
    const r = await runner.check([H], async () => view({ stops: [fake] }))
    expect(r.decision.mode).toBe("RUNNING")
    expect(runner.rememberedKeys()).toEqual([])
  })

  it("stays stopped when the STOP vanishes from Arkiv, and reports it", async () => {
    const { runner } = make()
    await runner.check([H], async () => view({ stops: [STOP] }))
    const r = await runner.check([H], async () => view({ stops: [] }))
    expect(r.decision.mode).toBe("STOPPED")
    expect(r.vanished.map((s) => s.key)).toEqual([STOP.key])
  })

  it("stays stopped when Arkiv becomes unreachable", async () => {
    const { runner, clock } = make()
    await runner.check([H], async () => view({ stops: [STOP] }))
    clock.t = 1
    const r = await runner.check([H], fail)
    expect(r.online).toBe(false)
    expect(r.decision.mode).toBe("STOPPED")
  })

  it("does not send receipts while offline", async () => {
    const { runner, clock } = make()
    await runner.check([H], async () => view({ stops: [] }))
    clock.t = 1
    const r = await runner.check([H], fail)
    expect(r.acks).toEqual([])
  })

  it("goes through grace, supervised and stop as time passes offline", async () => {
    const { runner, clock } = make()
    await runner.check([H], async () => view())
    clock.t = 500
    expect((await runner.check([H], fail)).decision.mode).toBe("RUNNING")
    clock.t = 1000
    expect((await runner.check([H], fail)).decision.mode).toBe("SUPERVISED")
    clock.t = 2000
    expect((await runner.check([H], fail)).decision.mode).toBe("STOPPED")
    expect((await runner.check([H], async () => view())).decision.mode).toBe("RUNNING")
  })

  it("offers the fix, and returns to work once the fixed file is loaded", async () => {
    const { runner } = make()
    const r = await runner.check([H], async () => view({ stops: [STOP], lifts: [FIX] }))
    expect(r.decision.mode).toBe("STOPPED")
    expect(r.fixes[0]?.lift.fixedHash).toBe(FIXED)
    const after = await runner.check([FIXED], async () => view({ stops: [] }))
    expect(after.decision.mode).toBe("RUNNING")
    expect(after.vanished).toEqual([])
  })

  it("remembers STOPs across a restart", async () => {
    const store = memoryStore()
    const a = make(store)
    await a.runner.check([H], async () => view({ stops: [STOP] }))
    a.runner.markAcked(STOP.key, "STOPPED")
    const b = make(store)
    const r = await b.runner.check([H], async () => view({ stops: [] }))
    expect(r.decision.mode).toBe("STOPPED")
    expect(r.acks).toEqual([])
  })

  it("asks to extend a STOP that is close to expiring", async () => {
    const { runner } = make()
    const soon = { ...STOP, expiresAt: 100n }
    const r = await runner.check([H], async () => view({ stops: [soon] }))
    expect(r.toExtend).toEqual([STOP.key])
    const far = await make().runner.check([H], async () => view({ stops: [STOP] }))
    expect(far.toExtend).toEqual([])
  })

  it("saves memory with bigints intact", () => {
    const memory = { stops: [STOP], lifts: [FIX], acked: ["x"], supervised: [], vanished: [] }
    expect(decodeMemory(encodeMemory(memory))).toEqual(memory)
  })
})
