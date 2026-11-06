import { describe, expect, it } from "vitest"
import { type BoardRobot, buildRecallBoard, deletedStops, plateColour } from "../src/board"
import type { AckAction, AckRow, HeartbeatRow, Hex, LoadoutRow, RecallRow } from "../src/types"

const R1: Hex = "0x00000000000000000000000000000000000000a1"
const R2: Hex = "0x00000000000000000000000000000000000000a2"
const R3: Hex = "0x00000000000000000000000000000000000000a3"
const MAKER: Hex = "0x00000000000000000000000000000000000000bb"
const OUTSIDER: Hex = "0x00000000000000000000000000000000000000cc"
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
  robot,
  seq: 1n,
  files: [{ kind: "policy", name: "p", version: "1", hash }],
  creator: robot,
  createdAt: 1n,
})

const beat = (robot: Hex, mode: HeartbeatRow["mode"] = "RUNNING", creator: Hex = robot): HeartbeatRow => ({
  key: "0x20",
  robot,
  mode,
  loadoutSeq: 1n,
  creator,
  updatedAt: 1n,
  expiresAt: 9n,
})

const entry = (robot: Hex, serial: string, hash = H, alive = true): BoardRobot => ({
  robot: { key: "0x30", robot, maker: MAKER, model: "m", serial, city: "c", creator: MAKER },
  loadout: loadout(robot, hash),
  heartbeat: alive ? beat(robot) : undefined,
})

const ack = (robot: Hex, action: AckAction, creator: Hex = robot, recall: Hex = RECALL.key): AckRow => ({
  key: "0x40",
  recall,
  recallHash: "0xc",
  robot,
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
      [ack(R1, "STOPPED"), ack(R2, "STOPPED")],
    )
    expect(board).toMatchObject({ affected: 3, obeyed: 2, silent: 1, noReceipt: 0 })
    expect(board.rows.map((r) => r.state)).toEqual(["STOPPED", "STOPPED", "SILENT"])
  })

  it("keeps robots that never answered on the board", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [])
    expect(board.rows.map((r) => r.state)).toEqual(["SILENT"])
  })

  it("tells a live robot with no receipt apart from a silent one", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1")], [])
    expect(board.rows[0]?.state).toBe("NO_RECEIPT")
    expect(board.noReceipt).toBe(1)
  })

  it("leaves out robots that never ran the file", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", FIXED)], [])
    expect(board.affected).toBe(0)
  })

  it("shows a robot as fixed once it runs new software and has said so", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", FIXED)], [ack(R1, "STOPPED"), ack(R1, "UPDATED")])
    expect(board.rows[0]?.state).toBe("FIXED")
    expect(board.obeyed).toBe(1)
  })

  it("does not believe an update receipt while the old file is still loaded", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H)], [ack(R1, "UPDATED")])
    expect(board.rows[0]?.state).toBe("NO_RECEIPT")
  })

  it("ignores receipts forged by someone other than the robot", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [ack(R1, "STOPPED", OUTSIDER)])
    expect(board.rows[0]?.state).toBe("SILENT")
    expect(board.obeyed).toBe(0)
  })

  it("ignores receipts for a different recall", () => {
    const board = buildRecallBoard(RECALL, [entry(R1, "1", H, false)], [ack(R1, "STOPPED", R1, "0x99")])
    expect(board.rows[0]?.state).toBe("SILENT")
  })

  it("shows a robot that slowed for a confirmed advisory", () => {
    const board = buildRecallBoard({ ...RECALL, level: "ADVISORY" }, [entry(R1, "1")], [ack(R1, "SLOWED")])
    expect(board.rows[0]?.state).toBe("SLOWED")
  })

  it("matches hashes regardless of case", () => {
    const board = buildRecallBoard({ ...RECALL, artifact: "0xBAD" }, [entry(R1, "1", "0xbad")], [])
    expect(board.affected).toBe(1)
  })
})

describe("deletedStops", () => {
  it("finds a STOP that robots receipted but that is gone from Arkiv", () => {
    const gone = deletedStops([ack(R1, "STOPPED"), ack(R2, "STOPPED")], [])
    expect(gone).toHaveLength(1)
    expect(gone[0]).toMatchObject({ recall: RECALL.key, issuer: MAKER, recallHash: "0xc" })
    expect(gone[0]?.receipts).toHaveLength(2)
  })

  it("reports nothing while the STOP still exists", () => {
    expect(deletedStops([ack(R1, "STOPPED")], [RECALL])).toEqual([])
  })

  it("is not fooled by a forged receipt for a STOP that never existed", () => {
    expect(deletedStops([ack(R1, "STOPPED", OUTSIDER, "0x77")], [])).toEqual([])
  })
})

describe("plateColour", () => {
  it("follows the robot's own heartbeat", () => {
    expect(plateColour(R1, beat(R1, "RUNNING"))).toBe("green")
    expect(plateColour(R1, beat(R1, "SUPERVISED"))).toBe("amber")
    expect(plateColour(R1, beat(R1, "PAUSED" as any))).toBe("amber")
    expect(plateColour(R1, beat(R1, "STOPPED"))).toBe("red")
  })

  it("is grey with no heartbeat", () => {
    expect(plateColour(R1, undefined)).toBe("grey")
  })

  it("ignores a fake green heartbeat from anyone else", () => {
    expect(plateColour(R1, beat(R1, "RUNNING", OUTSIDER))).toBe("grey")
  })
})
