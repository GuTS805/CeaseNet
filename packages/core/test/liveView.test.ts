import { describe, expect, it } from "vitest"
import { type BoardAgent, endedByIssuer, isLive, type LiftRow, onlyLive, type PublicView, type RecallRow } from "../src"

const OWNER = "0x00000000000000000000000000000000000000aa"
const ISSUER = "0x00000000000000000000000000000000000000bb"
const STRANGER = "0x00000000000000000000000000000000000000cc"

const FILE = "0x00000000000000000000000000000000000000000000000000000000000000f1"
const OTHER_FILE = "0x00000000000000000000000000000000000000000000000000000000000000f2"

const agentAt = (address: string, options: { live?: boolean; heartbeatFrom?: string; follows?: string[]; loads?: string } = {}): BoardAgent =>
  ({
    agent: { key: `0xkey${address}`, agent: address, owner: OWNER, name: `Agent ${address.slice(-2)}` },
    loadout: { key: "0xload", agent: address, seq: 1n, files: [{ kind: "tool", name: "some-tool", version: "1.0.0", hash: options.loads ?? FILE }], creator: address, createdAt: 1n },
    heartbeat: options.live ? { key: "0xbeat", agent: address, mode: "RUNNING", loadoutSeq: 1n, creator: options.heartbeatFrom ?? address, updatedAt: 1n, expiresAt: 2n } : undefined,
    policy: options.follows ? { issuers: options.follows, regulators: [], verifier: ISSUER, threshold: 3 } : undefined,
  }) as unknown as BoardAgent

const recallBy = (creator: string, key: string): RecallRow => ({ key, creator, level: "STOP", artifact: FILE, severity: "HIGH", reason: "It is bad", createdAt: 1n }) as unknown as RecallRow

const liftOf = (recall: string, creator: string, kind: LiftRow["kind"]): LiftRow => ({ key: "0xlift", recall, creator, kind, artifact: "0xfile", createdAt: 2n }) as unknown as LiftRow

const viewOf = (agents: BoardAgent[], recalls: RecallRow[] = [], lifts: LiftRow[] = []): PublicView => ({ block: 1n, agents, recalls, acks: [], lifts, endorsements: [], artifacts: [], disclosures: [] })

describe("what is happening now", () => {
  it("is the agents reporting right now, not everything that ever registered", () => {
    const view = viewOf([agentAt("0x01", { live: true }), agentAt("0x02"), agentAt("0x03")])
    expect(onlyLive(view).agents.map((a) => a.agent.agent)).toEqual(["0x01"])
  })

  it("does not count a heartbeat written by some other key", () => {
    expect(isLive(agentAt("0x01", { live: true, heartbeatFrom: STRANGER }))).toBe(false)
  })

  it("keeps a stopped agent while its heartbeat lasts, so a stop can be seen", () => {
    const stopped = agentAt("0x01", { live: true })
    stopped.heartbeat!.mode = "STOPPED"
    expect(isLive(stopped)).toBe(true)
  })

  it("keeps only recalls from keys a running agent's owner follows", () => {
    const view = viewOf([agentAt("0x01", { live: true, follows: [ISSUER] }), agentAt("0x02", { follows: [STRANGER] })], [recallBy(ISSUER, "0xa"), recallBy(STRANGER, "0xb")])
    expect(onlyLive(view).recalls.map((r) => r.key)).toEqual(["0xa"])
  })

  it("leaves out a recall that covers nothing a running agent loads, even from a key its owner follows", () => {
    const view = viewOf([agentAt("0x01", { live: true, follows: [ISSUER], loads: OTHER_FILE })], [recallBy(ISSUER, "0xa")])
    expect(onlyLive(view).recalls).toEqual([])
  })

  it("is empty when nothing is running, and leaves the full record alone", () => {
    const view = viewOf([agentAt("0x01", { follows: [ISSUER] })], [recallBy(ISSUER, "0xa")])
    const now = onlyLive(view)
    expect(now.agents).toEqual([])
    expect(now.recalls).toEqual([])
    expect(view.agents).toHaveLength(1)
    expect(view.recalls).toHaveLength(1)
  })
})

describe("a recall its issuer has ended", () => {
  it("counts only when the issuer itself took it back", () => {
    expect(endedByIssuer(recallBy(ISSUER, "0xa"), [liftOf("0xa", ISSUER, "WITHDRAWN")])).toBe(true)
    expect(endedByIssuer(recallBy(ISSUER, "0xa"), [liftOf("0xa", STRANGER, "WITHDRAWN")])).toBe(false)
  })

  it("does not include a fix, because the version it named is still recalled", () => {
    expect(endedByIssuer(recallBy(ISSUER, "0xa"), [liftOf("0xa", ISSUER, "FIX")])).toBe(false)
  })

  it("is no longer in force for running agents", () => {
    const view = viewOf([agentAt("0x01", { live: true, follows: [ISSUER] })], [recallBy(ISSUER, "0xa")], [liftOf("0xa", ISSUER, "WITHDRAWN")])
    expect(onlyLive(view).recalls).toEqual([])
  })
})
