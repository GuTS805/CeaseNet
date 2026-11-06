import {
  type AckIntent,
  type AgentStatus,
  type EndorseRow,
  type GateView,
  type Hex,
  type LiftRow,
  type LoadedFile,
  memoryStore,
  type RecallRow,
  type TrustPolicy,
} from "@ceasenet/core"
import { describe, expect, it } from "vitest"
import { type Approver, Guard, type GuardEvent, type GuardNet } from "../src/guard"

const MAKER: Hex = "0x00000000000000000000000000000000000000aa"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000cc"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000dd"
const policy: TrustPolicy = { issuers: [MAKER], regulators: [], verifier: VERIFIER, threshold: 3 }

const MAIL: LoadedFile = { kind: "tool", name: "demo-mail-tool", version: "1.0.16", hash: "0xbad" }
const FIXED: LoadedFile = { kind: "tool", name: "demo-mail-tool", version: "1.0.17", hash: "0xfeed" }
const FILES: LoadedFile = { kind: "tool", name: "demo-files-tool", version: "2.1.0", hash: "0xf11e" }
const MODEL: LoadedFile = { kind: "model", name: "glm", version: "1", hash: "0xa1" }

const STOP: RecallRow = {
  key: "0x01",
  artifact: MAIL.hash,
  level: "STOP",
  severity: "HIGH",
  reason: "copies every email to a stranger",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 5n,
  expiresAt: 7_000_000n,
}

const WARNING: RecallRow = { ...STOP, key: "0x02", level: "ADVISORY", creator: VERIFIER }

const endorsements = (recall: Hex, n: number): EndorseRow[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `0x1${i}` as Hex,
    recall,
    stance: "CONFIRM" as const,
    human: `h${i}`,
    creator: VERIFIER,
    createdAt: 9n,
  }))

const FIX: LiftRow = {
  key: "0x03",
  recall: STOP.key,
  artifact: MAIL.hash,
  kind: "FIX",
  fixedHash: FIXED.hash,
  creator: MAKER,
  createdAt: 8n,
}

class FakeNet implements GuardNet {
  view: Partial<GateView> = {}
  up = true
  acks: AckIntent[] = []
  loadouts: LoadedFile[][] = []
  beats: AgentStatus[] = []
  failAcks = false

  async readView(): Promise<GateView> {
    if (!this.up) throw new Error("no network")
    return { block: 10n, stops: [], advisories: [], endorsements: [], lifts: [], ...this.view }
  }
  async writeLoadout(_seq: bigint, files: LoadedFile[]) {
    this.loadouts.push(files)
  }
  async writeHeartbeat(status: AgentStatus) {
    this.beats.push(status)
  }
  async writeAck(intent: AckIntent) {
    if (this.failAcks) throw new Error("write failed")
    this.acks.push(intent)
  }
  async extendRecall() {}
}

const timers = { checkIntervalMs: 100, heartbeatIntervalMs: 100, heartbeatTtlSeconds: 10, graceMs: 1000, offlineSupervisedMs: 1000 }

function make(over: { approve?: Approver; files?: LoadedFile[] } = {}) {
  const net = new FakeNet()
  const clock = { t: 0 }
  const events: GuardEvent[] = []
  const guard = new Guard({
    policy,
    timers,
    store: memoryStore(),
    files: over.files ?? [MAIL, FILES, MODEL],
    net,
    startSeq: 1n,
    approve: over.approve,
    onEvent: (e) => events.push(e),
    now: () => clock.t,
  })
  /** The next check runs now, rather than being skipped as too soon after the last one. */
  const tick = (ms = 2000) => {
    clock.t += ms
  }
  return { guard, net, clock, events, tick }
}

describe("Guard", () => {
  it("refuses everything until it has read the list once", async () => {
    const { guard, net } = make()
    net.up = false
    const decision = guard["decide"](MAIL)
    expect(decision.allowed).toBe(false)
    expect(decision.message).toMatch(/not been able to read/)
  })

  it("allows a call when nothing applies", async () => {
    const { guard } = make()
    await guard.start()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(true)
  })

  it("publishes what the agent loaded when it starts", async () => {
    const { guard, net } = make()
    await guard.start()
    expect(net.loadouts).toEqual([[MAIL, FILES, MODEL]])
  })

  it("blocks a recalled tool, says why, and leaves the other tools working", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [STOP] }
    tick()
    const blocked = await guard.beforeCall(MAIL, "send_email")
    expect(blocked.allowed).toBe(false)
    expect(blocked.message).toContain("copies every email to a stranger")
    expect(blocked.recall?.key).toBe(STOP.key)
    tick()
    expect((await guard.beforeCall(FILES, "read_invoice")).allowed).toBe(true)
    expect(guard.status).toBe("RUNNING")
  })

  it("posts one receipt however many times a tool is blocked", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [STOP] }
    for (let i = 0; i < 3; i++) {
      tick()
      await guard.beforeCall(MAIL, "send_email")
      await new Promise((r) => setTimeout(r))
    }
    expect(net.acks.map((a) => a.action)).toEqual(["BLOCKED"])
  })

  it("tries a failed receipt again", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [STOP] }
    net.failAcks = true
    tick()
    await guard.check()
    await new Promise((r) => setTimeout(r))
    expect(net.acks).toEqual([])
    net.failAcks = false
    tick()
    await guard.check()
    await new Promise((r) => setTimeout(r))
    expect(net.acks.map((a) => a.action)).toEqual(["BLOCKED"])
  })

  it("ignores a STOP from a key the owner does not follow", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [{ ...STOP, creator: OUTSIDER }] }
    tick()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(true)
  })

  it("follows a change to the owner's trust list", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [STOP], policy: { ...policy, issuers: [] } }
    tick()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(true)
    net.view = { stops: [STOP], policy }
    tick()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
  })

  it("stops the whole agent when its model is recalled", async () => {
    const { guard, net, tick, events } = make()
    await guard.start()
    net.view = { stops: [{ ...STOP, artifact: MODEL.hash }] }
    tick()
    await guard.check()
    expect(guard.status).toBe("STOPPED")
    expect((await guard.beforeCall(FILES, "read_invoice")).allowed).toBe(false)
    expect(events.some((e) => e.kind === "STATUS" && e.to === "STOPPED")).toBe(true)
    expect(net.beats.at(-1)).toBe("STOPPED")
  })

  it("does not let through a file it never measured", async () => {
    const { guard, tick } = make()
    await guard.start()
    tick()
    const other: LoadedFile = { ...FILES, hash: "0xswapped" }
    const d = await guard.beforeCall(other, "read_invoice")
    expect(d.allowed).toBe(false)
    expect(d.message).toMatch(/never measured/)
  })

  it("keeps a tool blocked after the STOP is deleted from the list", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    net.view = { stops: [STOP] }
    tick()
    await guard.check()
    net.view = { stops: [] }
    tick()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
    expect(guard.lastCheck?.vanished.map((v) => v.key)).toEqual([STOP.key])
  })

  it("goes from grace to human approval to refusal when the list cannot be read", async () => {
    const answers: string[] = []
    const { guard, net, tick } = make({
      approve: async (r) => {
        answers.push(r.reason)
        return "DENIED"
      },
    })
    await guard.start()
    net.up = false
    guard.setNetwork(false)
    tick(500)
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(true)
    tick(500)
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
    expect(answers).toHaveLength(1)
    tick(1000)
    const refused = await guard.beforeCall(FILES, "read_invoice")
    expect(refused.verdict).toBe("BLOCK")
    expect(answers).toHaveLength(1)
  })

  it("works again and catches up once the list can be read again", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    guard.setNetwork(false)
    tick(5000)
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
    net.view = { stops: [STOP] }
    guard.setNetwork(true)
    tick()
    await guard.check()
    await new Promise((r) => setTimeout(r))
    expect(net.acks.map((a) => a.action)).toEqual(["BLOCKED"])
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
    tick()
    expect((await guard.beforeCall(FILES, "read_invoice")).allowed).toBe(true)
  })

  it("writes no heartbeat while cut off", async () => {
    const { guard, net } = make()
    await guard.start()
    const before = net.beats.length
    guard.setNetwork(false)
    await guard.beat()
    expect(net.beats.length).toBe(before)
  })

  it("reports the agent as paused when its model is out of reach", async () => {
    const { guard, net } = make()
    await guard.start()
    guard.setPaused(true)
    expect(guard.status).toBe("PAUSED")
    expect(net.beats.at(-1)).toBe("PAUSED")
    guard.setPaused(false)
    expect(guard.status).toBe("RUNNING")
  })
})

describe("human approval", () => {
  const warned = (net: FakeNet) => {
    net.view = { advisories: [WARNING], endorsements: endorsements(WARNING.key, 3) }
  }

  it("runs the call once a human approves", async () => {
    const { guard, net, tick } = make({ approve: async () => "APPROVED" })
    await guard.start()
    warned(net)
    tick()
    const d = await guard.beforeCall(MAIL, "send_email")
    expect(d).toMatchObject({ allowed: true, approval: "APPROVED", verdict: "NEEDS_APPROVAL" })
  })

  it("refuses the call when the human says no, and when nobody answers", async () => {
    const denied = make({ approve: async () => "DENIED" })
    await denied.guard.start()
    warned(denied.net)
    denied.tick()
    expect(await denied.guard.beforeCall(MAIL, "send_email")).toMatchObject({ allowed: false, approval: "DENIED" })

    const expired = make({ approve: async () => "EXPIRED" })
    await expired.guard.start()
    warned(expired.net)
    expired.tick()
    expect(await expired.guard.beforeCall(MAIL, "send_email")).toMatchObject({ allowed: false, approval: "EXPIRED" })
  })

  it("refuses the call when nobody is set up to approve", async () => {
    const { guard, net, tick } = make()
    await guard.start()
    warned(net)
    tick()
    const d = await guard.beforeCall(MAIL, "send_email")
    expect(d.allowed).toBe(false)
    expect(d.message).toMatch(/Nobody is set up/)
  })

  it("does not ask about a tool the warning does not cover", async () => {
    let asked = 0
    const { guard, net, tick } = make({
      approve: async () => {
        asked++
        return "APPROVED"
      },
    })
    await guard.start()
    warned(net)
    tick()
    expect((await guard.beforeCall(FILES, "read_invoice")).allowed).toBe(true)
    expect(asked).toBe(0)
  })

  it("refuses a call that was approved if a STOP arrived in the meantime", async () => {
    const { guard, net, tick } = make({
      approve: async () => {
        net.view = { stops: [STOP] }
        return "APPROVED"
      },
    })
    await guard.start()
    warned(net)
    tick()
    const d = await guard.beforeCall(MAIL, "send_email")
    expect(d.allowed).toBe(false)
    expect(d.verdict).toBe("BLOCK")
  })

  it("ends the wait as soon as a STOP is seen", async () => {
    let seenAbort = false
    const { guard, net, tick } = make({
      approve: (_r, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            seenAbort = true
            resolve("EXPIRED")
          })
        }),
    })
    await guard.start()
    warned(net)
    tick()
    const waiting = guard.beforeCall(MAIL, "send_email")
    await new Promise((r) => setTimeout(r, 10))
    net.view = { stops: [STOP] }
    tick()
    await guard.check()
    const d = await waiting
    expect(seenAbort).toBe(true)
    expect(d).toMatchObject({ allowed: false, verdict: "BLOCK" })
  })
})

describe("moving to a fix", () => {
  const underFix = async () => {
    const m = make()
    await m.guard.start()
    m.net.view = { stops: [STOP], lifts: [FIX] }
    m.tick()
    await m.guard.check()
    return m
  }

  it("refuses a version that does not match the published fix", async () => {
    const { guard } = await underFix()
    const fake = { ...FIXED, hash: "0xnot-the-fix" }
    expect(await guard.adoptFix(guard.lastCheck!.fixes[0]!, fake)).toBe(false)
    expect(guard.lastError).toMatch(/does not match/)
    expect(guard.files).toContain(MAIL)
  })

  it("uses the tool again after moving to the fix, and says so publicly", async () => {
    const { guard, net, tick } = await underFix()
    expect(await guard.adoptFix(guard.lastCheck!.fixes[0]!, FIXED)).toBe(true)
    expect(net.loadouts.at(-1)).toContain(FIXED)
    expect(net.loadouts.at(-1)).not.toContain(MAIL)
    expect(net.acks.map((a) => a.action)).toContain("UPDATED")
    tick()
    expect((await guard.beforeCall(FIXED, "send_email")).allowed).toBe(true)
  })

  it("keeps the old version blocked after a fix exists", async () => {
    const { guard, tick } = await underFix()
    tick()
    expect((await guard.beforeCall(MAIL, "send_email")).allowed).toBe(false)
  })

  it("does not count the old file as blocked once it is gone", async () => {
    const { guard } = await underFix()
    await guard.adoptFix(guard.lastCheck!.fixes[0]!, FIXED)
    expect(guard.toolVerdicts.map((t) => t.verdict)).toEqual(["ALLOW", "ALLOW"])
  })
})
