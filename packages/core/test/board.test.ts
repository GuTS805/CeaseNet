import { describe, expect, it } from "vitest"
import { type BoardAgent, buildRecallBoard, deletedStops, statusColourOf } from "../src/board"
import type { AckAction, AckRow, HeartbeatRow, Hex, LoadoutRow, RecallRow, TrustPolicy } from "../src/types"

const R1: Hex = "0x00000000000000000000000000000000000000a1"
const R2: Hex = "0x00000000000000000000000000000000000000a2"
const R3: Hex = "0x00000000000000000000000000000000000000a3"
const MAKER: Hex = "0x00000000000000000000000000000000000000bb"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000cc"
const OWNER: Hex = "0x00000000000000000000000000000000000000dd"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000ee"
const H = "0xbad"
const FIXED = "0xgood"

const RECALL: RecallRow = {
  key: "0x01",
  artifact: H,
  level: "STOP",
  severity: "HIGH",
  reason: "r",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 1n,
  expiresAt: 9n,
}

const loadout = (robot: Hex, hash: string): LoadoutRow => ({
  key: "0x10",
  agent: robot,
  seq: 1n,
  files: [{ kind: "tool", name: "demo-mail-tool", version: "1.0.16", hash }],
  creator: robot,
  createdAt: 1n,
})

const beat = (robot: Hex, mode: HeartbeatRow["mode"] = "RUNNING", creator: Hex = robot): HeartbeatRow => ({
  key: "0x20",
  agent: robot,
  mode,
  loadoutSeq: 1n,
  creator,
  updatedAt: 1n,
  expiresAt: 9n,
})

const entry = (robot: Hex, serial: string, hash = H, alive = true, policy?: TrustPolicy): BoardAgent => ({
  agent: { key: "0x30", agent: robot, owner: OWNER, name: serial, framework: "f", purpose: "p", creator: OWNER },
  loadout: loadout(robot, hash),
  heartbeat: alive ? beat(robot) : undefined,
  policy,
})

const ack = (robot: Hex, action: AckAction, creator: Hex = robot, recall: Hex = RECALL.key): AckRow => ({
  key: "0x40",
  recall,
  recallHash: "0xc",
  agent: robot,
  artifact: H,
  action,
  issuer: MAKER,
  creator,
  createdAt: 2n,
})

describe("buildRecallBoard", () => {
  it("shows the demo moment: 2 of 3 obeyed, 1 silent", () => {
    const board = buildRecallBoard(
      RECALL,
      [entry(R1, "1"), entry(R2, "2"), entry(R3, "3", H, false)],
      [ack(R1, "BLOCKED"), ack(R2, "BLOCKED")],
    )
    expect(board).toMatchObject({ affected: 3, obeyed: 2, silent: 1, noReceipt: 0 })
    expect(board.rows.map((r) => r.state)).toEqual(["BLOCKED", "BLOCKED", "SILENT"])
  })

  it("keeps agents that never answered on the board", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [])
    expect(board.rows.map((r) => r.state)).toEqual(["SILENT"])
  })

  it("tells a live agent with no receipt apart from a silent one", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1")], [])
    expect(board.rows[0]?.state).toBe("NO_RECEIPT")
    expect(board.noReceipt).toBe(1)
  })

  it("leaves out agents that never loaded the file", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", FIXED)], [])
    expect(board.affected).toBe(0)
  })

  it("shows an agent as fixed once it runs the new version and has said so", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", FIXED)], [ack(R1, "BLOCKED"), ack(R1, "UPDATED")])
    expect(board.rows[0]?.state).toBe("FIXED")
    expect(board.obeyed).toBe(1)
  })

  it("does not believe an update receipt while the old file is still loaded", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H)], [ack(R1, "UPDATED")])
    expect(board.rows[0]?.state).toBe("NO_RECEIPT")
  })

  it("ignores receipts forged by someone other than the agent", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [ack(R1, "BLOCKED", OUTSIDER)])
    expect(board.rows[0]?.state).toBe("SILENT")
    expect(board.obeyed).toBe(0)
  })

  it("ignores receipts for a different recall", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [ack(R1, "BLOCKED", R1, "0x99")])
    expect(board.rows[0]?.state).toBe("SILENT")
  })

  it("shows an agent asking a human because of a confirmed warning", () => {
    const board = buildRecallBoard({ ...RECALL, level: "ADVISORY" }, [entry(R1, "1")], [ack(R1, "SUPERVISED")])
    expect(board.rows[0]?.state).toBe("SUPERVISED")
  })

  it("matches hashes regardless of case", () => {
    const board = buildRecallBoard({ ...RECALL, artifact: "0xBAD" }, [entry(R1, "1", "0xbad")], [])
    expect(board.affected).toBe(1)
  })
})

describe("whom an owner follows", () => {
  const follower: TrustPolicy = { issuers: [MAKER], regulators: [], verifier: VERIFIER, threshold: 3 }
  const other: TrustPolicy = { issuers: [OUTSIDER], regulators: [], verifier: OUTSIDER, threshold: 3 }

  it("does not count an agent whose owner does not follow the issuer as disobeying", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, true, other), entry(R2, "2", H, true, follower)], [ack(R2, "BLOCKED")])
    expect(board).toMatchObject({ affected: 1, obeyed: 1, notFollowing: 1, noReceipt: 0 })
    expect(board.rows.map((r) => r.state)).toEqual(["NOT_FOLLOWING", "BLOCKED"])
  })

  it("treats an agent with no published list as following", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1")], [])
    expect(board.notFollowing).toBe(0)
  })

  it("checks a warning against the verifier the owner follows", () => {
    const warning = { ...RECALL, level: "ADVISORY" as const, creator: VERIFIER }
    const board = buildRecallBoard(warning, [entry(R1, "1", H, true, other), entry(R2, "2", H, true, follower)], [])
    expect(board.rows.map((r) => r.state)).toEqual(["NOT_FOLLOWING", "NO_RECEIPT"])
  })
})

describe("recalls by version range", () => {
  it("finds agents on a covered version even if the hash differs", () => {
    const byRange = { ...RECALL, artifact: "0xdifferent", pkg: "demo-mail-tool", versions: ">=1.0.16 <1.0.17" }
    expect(buildRecallBoard(byRange, [entry(R1, "1")], []).affected).toBe(1)
  })
})

describe("deletedStops", () => {
  it("finds a STOP that agents receipted but that is gone from Arkiv", () => {
    const gone = deletedStops([ack(R1, "BLOCKED"), ack(R2, "BLOCKED")], [])
    expect(gone).toHaveLength(1)
    expect(gone[0]).toMatchObject({ recall: RECALL.key, issuer: MAKER, recallHash: "0xc" })
    expect(gone[0]?.receipts).toHaveLength(2)
  })

  it("reports nothing while the STOP still exists", () => {
    expect(deletedStops([ack(R1, "BLOCKED")], [RECALL])).toEqual([])
  })

  it("is not fooled by a forged receipt for a STOP that never existed", () => {
    expect(deletedStops([ack(R1, "BLOCKED", OUTSIDER, "0x77")], [])).toEqual([])
  })
})

describe("statusColourOf", () => {
  it("follows the agent's own heartbeat", () => {
    expect(statusColourOf(R1, beat(R1, "RUNNING"))).toBe("green")
    expect(statusColourOf(R1, beat(R1, "SUPERVISED"))).toBe("amber")
    expect(statusColourOf(R1, beat(R1, "PAUSED" as any))).toBe("amber")
    expect(statusColourOf(R1, beat(R1, "STOPPED"))).toBe("red")
  })

  it("is grey with no heartbeat", () => {
    expect(statusColourOf(R1, undefined)).toBe("grey")
  })

  it("ignores a fake green heartbeat from anyone else", () => {
    expect(statusColourOf(R1, beat(R1, "RUNNING", OUTSIDER))).toBe("grey")
  })
})
