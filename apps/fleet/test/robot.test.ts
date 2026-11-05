import loadMujoco from "@mujoco/mujoco"
import { beforeAll, describe, expect, it } from "vitest"
import {
  type AckIntent,
  type GateView,
  type Hex,
  type LiftRow,
  makeTrust,
  memoryStore,
  type RecallRow,
} from "@ceasenet/core"
import { replay, RobotSim } from "@ceasenet/sim"
import { chooseMove, DevPlanner, parseMove, PlannerInvalidReply, PlannerUnavailable, ZeroGPlanner } from "../src/planner"
import { RobotRuntime, type RobotNet } from "../src/robot"
import { loadSoftware, type PolicyVersion } from "../src/software"

let mujoco: unknown
beforeAll(async () => {
  mujoco = await loadMujoco()
})

const MAKER: Hex = "0x00000000000000000000000000000000000000aa"
const VERIFIER: Hex = "0x00000000000000000000000000000000000000cc"
const SALT = "test"

const trust = makeTrust({ stopKeys: [MAKER], regulators: [], verifier: VERIFIER, threshold: 3, windowBlocks: 1000n })

class FakeNet implements RobotNet {
  stops: RecallRow[] = []
  lifts: LiftRow[] = []
  acks: { intent: AckIntent; newHash?: string }[] = []
  loadouts: bigint[] = []
  beats: string[] = []
  failReads = false

  async readView(): Promise<GateView> {
    if (this.failReads) throw new Error("no network")
    return { block: 100n, stops: this.stops, advisories: [], endorsements: [], lifts: this.lifts }
  }
  async writeLoadout(seq: bigint) {
    this.loadouts.push(seq)
  }
  async writeHeartbeat(status: string) {
    this.beats.push(status)
  }
  async writeAck(intent: AckIntent, _artifact: string, newHash?: string) {
    this.acks.push({ intent, newHash })
  }
  async extendRecall() {}
}

const stopOn = (artifact: string): RecallRow => ({
  key: "0x01",
  artifact,
  level: "STOP",
  severity: "HIGH",
  reason: "defect",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 5n,
  expiresAt: 8_000_000n,
})

const version = (v: PolicyVersion) => loadSoftware(v, SALT, "test-model")

function make(over: { autoUpdate?: boolean; planner?: any; loadVersion?: any } = {}) {
  const net = new FakeNet()
  const clock = { t: 1_000_000 }
  const robot = new RobotRuntime({
    id: 1,
    address: "0x00000000000000000000000000000000000000f1",
    sim: new RobotSim(mujoco),
    net,
    planner: over.planner ?? new DevPlanner(),
    trust,
    timers: {
      checkIntervalMs: 2000,
      heartbeatIntervalMs: 8000,
      heartbeatTtlSeconds: 30,
      graceMs: 20_000,
      offlineSupervisedMs: 20_000,
    },
    store: memoryStore(),
    software: version("1.5.2"),
    loadVersion: over.loadVersion ?? version,
    autoUpdate: over.autoUpdate ?? true,
    startSeq: 1n,
    now: () => clock.t,
  })
  return { robot, net, clock }
}

/** Lets pending promises finish. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

/** Runs the robot in small steps with time passing, as the server loop does. */
async function run(robot: RobotRuntime, clock: { t: number }, steps: number) {
  for (let i = 0; i < steps; i += 50) {
    robot.pump(50)
    clock.t += 100
    await settle()
  }
}

describe("RobotRuntime", () => {
  it("publishes its loadout and heartbeat on start", async () => {
    const { robot, net } = make()
    await robot.start()
    expect(net.loadouts).toEqual([1n])
    expect(net.beats).toEqual(["RUNNING"])
  })

  it("works through decisions while nothing is wrong", async () => {
    const { robot, clock } = make()
    await robot.start()
    await run(robot, clock, 8000)
    expect(robot.decisions.length).toBeGreaterThan(1)
    expect(robot.decisions.every((d) => d.requestId.startsWith("dev-"))).toBe(true)
    expect(robot.status).toBe("RUNNING")
  })

  it("stops on a STOP and posts one receipt", async () => {
    const { robot, net, clock } = make({ autoUpdate: false })
    await robot.start()
    await run(robot, clock, 1000)
    net.stops = [stopOn(robot.software.policyHash)]
    await robot.checkGate(true)
    await settle()
    expect(robot.status).toBe("STOPPED")
    expect(robot.sim.mode).toBe("STOPPED")
    await robot.checkGate(true)
    await settle()
    expect(net.acks.map((a) => a.intent.action)).toEqual(["STOPPED"])
  })

  it("makes no decisions while stopped", async () => {
    const { robot, net, clock } = make({ autoUpdate: false })
    await robot.start()
    net.stops = [stopOn(robot.software.policyHash)]
    await robot.checkGate(true)
    const before = robot.decisions.length
    await run(robot, clock, 6000)
    expect(robot.decisions.length).toBe(before)
    expect(robot.sim.holding).toBeNull()
  })

  it("installs a fix, publishes it, and returns to work", async () => {
    const { robot, net, clock } = make()
    await robot.start()
    const stop = stopOn(robot.software.policyHash)
    net.stops = [stop]
    net.lifts = [
      {
        key: "0x02",
        recall: stop.key,
        artifact: stop.artifact,
        kind: "FIX",
        fixedHash: version("1.5.3").policyHash,
        creator: MAKER,
        createdAt: 6n,
      },
    ]
    await robot.checkGate(true)
    await settle()
    await run(robot, clock, 500)
    expect(robot.software.version).toBe("1.5.3")
    expect(robot.status).toBe("RUNNING")
    expect(net.loadouts).toEqual([1n, 2n])
    const updated = net.acks.find((a) => a.intent.action === "UPDATED")
    expect(updated?.newHash).toBe(version("1.5.3").policyHash)
  })

  it("refuses a fix whose hash does not match, and stays stopped", async () => {
    const { robot, net, clock } = make()
    await robot.start()
    const stop = stopOn(robot.software.policyHash)
    net.stops = [stop]
    net.lifts = [
      { key: "0x02", recall: stop.key, artifact: stop.artifact, kind: "FIX", fixedHash: "0xbad", creator: MAKER, createdAt: 6n },
    ]
    await robot.checkGate(true)
    await settle()
    await run(robot, clock, 200)
    expect(robot.software.version).toBe("1.5.2")
    expect(robot.status).toBe("STOPPED")
    expect(robot.lastError).toMatch(/refused/)
  })

  it("stays stopped without auto-update until someone installs the fix", async () => {
    const { robot, net, clock } = make({ autoUpdate: false })
    await robot.start()
    const stop = stopOn(robot.software.policyHash)
    net.stops = [stop]
    net.lifts = [
      {
        key: "0x02",
        recall: stop.key,
        artifact: stop.artifact,
        kind: "FIX",
        fixedHash: version("1.5.3").policyHash,
        creator: MAKER,
        createdAt: 6n,
      },
    ]
    await robot.checkGate(true)
    await run(robot, clock, 200)
    expect(robot.status).toBe("STOPPED")
    expect(await robot.installFix()).toBe(true)
    expect(robot.status).toBe("RUNNING")
  })

  it("pauses safely when 0G is switched off, and invents nothing", async () => {
    const { robot, clock } = make()
    await robot.start()
    await run(robot, clock, 500)
    robot.setPlanner(false)
    await run(robot, clock, 8000)
    expect(robot.status).toBe("PAUSED")
    expect(robot.sim.mode).toBe("PAUSED")
    expect(robot.sim.holding).toBeNull()
    const count = robot.decisions.length
    await run(robot, clock, 4000)
    expect(robot.decisions.length).toBe(count)
  })

  it("carries on when 0G returns", async () => {
    const { robot, clock } = make()
    await robot.start()
    robot.setPlanner(false)
    await run(robot, clock, 4000)
    expect(robot.status).toBe("PAUSED")
    const count = robot.decisions.length
    robot.setPlanner(true)
    await run(robot, clock, 8000)
    expect(robot.status).toBe("RUNNING")
    expect(robot.decisions.length).toBeGreaterThan(count)
  })

  it("pauses after repeated nonsense from the planner", async () => {
    const planner = {
      decide: async () => {
        throw new PlannerInvalidReply("nonsense", "hello")
      },
    }
    const { robot, clock } = make({ planner })
    await robot.start()
    await run(robot, clock, 2000)
    expect(robot.status).toBe("PAUSED")
    expect(robot.decisions).toEqual([])
  })

  it("rejects an impossible move from the planner", async () => {
    const planner = {
      decide: async () => ({ move: { box: 0, slot: 1 }, requestId: "r", model: "m", raw: "{}", source: "0g" as const }),
    }
    const { robot, clock } = make({ planner })
    await robot.start()
    await run(robot, clock, 2000)
    expect(robot.decisions).toEqual([])
    expect(robot.status).toBe("PAUSED")
  })

  it("throws away a decision that arrives after a STOP", async () => {
    let release = (_: unknown) => {}
    const planner = {
      decide: () =>
        new Promise<any>((resolve) => {
          release = () => resolve({ move: { box: 0, slot: 4 }, requestId: "late", model: "m", raw: "{}", source: "0g" })
        }),
    }
    const { robot, net, clock } = make({ planner, autoUpdate: false })
    await robot.start()
    await run(robot, clock, 100)
    net.stops = [stopOn(robot.software.policyHash)]
    await robot.checkGate(true)
    release(undefined)
    await settle()
    expect(robot.decisions).toEqual([])
    expect(robot.status).toBe("STOPPED")
  })

  it("goes through grace, supervised and stop when its internet is cut", async () => {
    const { robot, clock } = make()
    await robot.start()
    robot.setNetwork(false)
    await robot.checkGate(true)
    expect(robot.status).toBe("RUNNING")
    clock.t += 20_000
    await robot.checkGate(true)
    expect(robot.status).toBe("SUPERVISED")
    clock.t += 20_000
    await robot.checkGate(true)
    expect(robot.status).toBe("STOPPED")
  })

  it("finds a STOP issued while it was offline as soon as it reconnects, and receipts it", async () => {
    const { robot, net } = make({ autoUpdate: false })
    await robot.start()
    robot.setNetwork(false)
    net.stops = [stopOn(robot.software.policyHash)]
    await robot.checkGate(true)
    expect(robot.status).toBe("RUNNING")
    expect(net.acks).toEqual([])
    robot.setNetwork(true)
    await settle()
    expect(robot.status).toBe("STOPPED")
    expect(net.acks.map((a) => a.intent.action)).toEqual(["STOPPED"])
  })

  it("records a run that replays exactly, step for step", async () => {
    const { robot, net, clock } = make()
    await robot.start()
    await run(robot, clock, 5000)
    net.stops = [stopOn(robot.software.policyHash)]
    await robot.checkGate(true)
    await run(robot, clock, 3000)
    robot.setPlanner(false)
    expect(robot.events.some((e) => e.kind === "MODE")).toBe(true)
    expect(robot.events.some((e) => e.kind === "MOVE")).toBe(true)
    const result = replay(new RobotSim(mujoco), robot.events)
    expect(result.firstMismatchTick).toBeNull()
    expect(result.matched).toBe(result.total)
  })

  const recordedRun = async () => {
    const { robot, clock } = make()
    await robot.start()
    await run(robot, clock, 6000)
    const moves = robot.events.filter((e) => e.kind === "MOVE")
    expect(moves.length).toBeGreaterThan(1)
    return { events: robot.events, first: moves[0]! }
  }

  it("detects a log where a move was changed to a different possible one", async () => {
    const { events, first } = await recordedRun()
    const tampered = events.map((e) => (e === first ? { ...e, move: { box: 1, slot: 5 } } : e))
    const result = replay(new RobotSim(mujoco), tampered as any)
    expect(result.firstMismatchTick).not.toBeNull()
  })

  it("reports an impossible move in a log instead of crashing", async () => {
    const { events, first } = await recordedRun()
    const tampered = events.map((e) => (e === first ? { ...e, move: { box: 99, slot: 7 } } : e))
    const result = replay(new RobotSim(mujoco), tampered as any)
    expect(result.impossible).toMatch(/invalid move/)
    expect(result.firstMismatchTick).not.toBeNull()
  })

  it("detects a log with a changed state fingerprint", async () => {
    const { events, first } = await recordedRun()
    const tampered = events.map((e) => (e === first ? { ...e, state: "0000000000000000" } : e))
    expect(replay(new RobotSim(mujoco), tampered as any).firstMismatchTick).toBe(first.tick)
  })
})

describe("software", () => {
  it("hashes the two policy versions differently", () => {
    expect(version("1.5.2").policyHash).not.toBe(version("1.5.3").policyHash)
  })

  it("gives each demo run its own hashes", () => {
    expect(loadSoftware("1.5.2", "a", "m").policyHash).not.toBe(loadSoftware("1.5.2", "b", "m").policyHash)
  })

  it("includes the planner prompt and model in what can be recalled", () => {
    const kinds = version("1.5.2").files.map((f) => f.kind)
    expect(kinds).toEqual(["policy", "firmware", "prompt", "model"])
  })
})

describe("planner", () => {
  const obs = {
    boxes: [
      { at: "slot" as const, slot: 0 },
      { at: "slot" as const, slot: 1 },
      { at: "slot" as const, slot: 2 },
      { at: "slot" as const, slot: 3 },
    ],
    freeSlots: [4, 5, 6, 7],
    holding: null,
  }

  it("reads a move from a plain or fenced reply", () => {
    expect(parseMove('{"box": 1, "slot": 5}')).toEqual({ box: 1, slot: 5 })
    expect(parseMove('```json\n{"box":2,"slot":6}\n```')).toEqual({ box: 2, slot: 6 })
  })

  it("rejects replies that are not moves", () => {
    expect(() => parseMove("I think box 1")).toThrow(PlannerInvalidReply)
    expect(() => parseMove('{"box":"one"}')).toThrow(PlannerInvalidReply)
  })

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch

  it("returns the request ID from 0G", async () => {
    const f = reply(200, { request_id: "req_1", model: "m", choices: [{ message: { content: '{"box":0,"slot":4}' } }] })
    const d = await new ZeroGPlanner("k", "m", f).decide(obs, "p")
    expect(d).toMatchObject({ requestId: "req_1", move: { box: 0, slot: 4 }, source: "0g" })
  })

  it("falls back to the header, then the completion ID, for the request ID", async () => {
    const content = { choices: [{ message: { content: '{"box":0,"slot":4}' } }] }
    const a = await new ZeroGPlanner("k", "m", reply(200, content, { "x-request-id": "hdr" })).decide(obs, "p")
    expect(a.requestId).toBe("hdr")
    const b = await new ZeroGPlanner("k", "m", reply(200, { id: "cmpl", ...content })).decide(obs, "p")
    expect(b.requestId).toBe("cmpl")
  })

  it("treats a reply with no request ID as unusable", async () => {
    const f = reply(200, { choices: [{ message: { content: '{"box":0,"slot":4}' } }] })
    await expect(new ZeroGPlanner("k", "m", f).decide(obs, "p")).rejects.toThrow(PlannerUnavailable)
  })

  it("reports out-of-funds and outages as unavailable", async () => {
    await expect(new ZeroGPlanner("k", "m", reply(402, { error: {} })).decide(obs, "p")).rejects.toThrow(PlannerUnavailable)
    await expect(new ZeroGPlanner("k", "m", reply(503, { error: {} })).decide(obs, "p")).rejects.toThrow(PlannerUnavailable)
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await expect(new ZeroGPlanner("k", "m", boom).decide(obs, "p")).rejects.toThrow(PlannerUnavailable)
  })

  it("dev rules always choose a possible move", () => {
    const sim = new RobotSim(mujoco)
    expect(sim.isValidMove(chooseMove(sim.observation()))).toBe(true)
    expect(chooseMove(obs)).toEqual({ box: 0, slot: 4 })
  })
})
