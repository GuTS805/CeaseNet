import loadMujoco from "@mujoco/mujoco"
import { beforeAll, describe, expect, it } from "vitest"
import { BOX_SIZE, RobotSim, SLOTS, TABLE_TOP, TRAY } from "../src/index"

let mujoco: unknown

beforeAll(async () => {
  mujoco = await loadMujoco()
})

const runUntilIdle = (sim: RobotSim, limit = 40_000) => {
  let steps = 0
  do {
    sim.step(10)
    steps += 10
    if (steps > limit) throw new Error("arm never finished")
  } while (!sim.idle)
  return steps
}

const boxPos = (sim: RobotSim, i: number) => {
  const a = 4 + i * 7
  return sim.qpos().slice(a, a + 3) as [number, number, number]
}

describe("RobotSim", () => {
  it("moves a box to the slot the planner chose", () => {
    const sim = new RobotSim(mujoco)
    expect(sim.isValidMove({ box: 0, slot: 4 })).toBe(true)
    sim.startMove({ box: 0, slot: 4 })
    runUntilIdle(sim)
    sim.step(500)
    const [x, y, z] = boxPos(sim, 0)
    const [sx, sy] = SLOTS[4]!
    expect(Math.hypot(x - sx, y - sy)).toBeLessThan(0.02)
    expect(z).toBeGreaterThan(TABLE_TOP)
    expect(z).toBeLessThan(TABLE_TOP + BOX_SIZE)
    expect(sim.observation().boxes[0]).toEqual({ at: "slot", slot: 4 })
    expect(sim.observation().freeSlots).toContain(0)
  })

  it("refuses moves that are physically impossible", () => {
    const sim = new RobotSim(mujoco)
    expect(sim.isValidMove({ box: 9, slot: 4 })).toBe(false)
    expect(sim.isValidMove({ box: 0, slot: 1 })).toBe(false)
    expect(sim.isValidMove({ box: 0, slot: 99 })).toBe(false)
    expect(sim.isValidMove({ box: 0.5, slot: 4 })).toBe(false)
    expect(() => sim.startMove({ box: 0, slot: 1 })).toThrow()
  })

  it("puts down what it holds and goes home on STOP", () => {
    const sim = new RobotSim(mujoco)
    sim.startMove({ box: 1, slot: 5 })
    for (let i = 0; sim.holding === null; i++) { if (i > 4000) throw new Error("never grabbed"); sim.step(10) }
    sim.step(200)
    sim.setMode("STOPPED")
    runUntilIdle(sim)
    sim.step(500)
    expect(sim.holding).toBeNull()
    expect(sim.observation().boxes[1]).toEqual({ at: "tray", index: 0 })
    const [x, y, z] = boxPos(sim, 1)
    const [tx, ty] = TRAY[0]!
    expect(Math.hypot(x - tx, y - ty)).toBeLessThan(0.02)
    expect(z).toBeGreaterThan(TABLE_TOP)
    expect(z).toBeLessThan(TABLE_TOP + BOX_SIZE + 0.01)
  })

  it("refuses new work while stopped", () => {
    const sim = new RobotSim(mujoco)
    sim.setMode("STOPPED")
    runUntilIdle(sim)
    expect(() => sim.startMove({ box: 0, slot: 4 })).toThrow(/STOPPED/)
  })

  it("takes about four times longer over the same path while supervised", () => {
    const patrolSteps = (mode: "RUNNING" | "SUPERVISED") => {
      const sim = new RobotSim(mujoco)
      sim.setMode(mode)
      runUntilIdle(sim)
      sim.startPatrol()
      return runUntilIdle(sim)
    }
    const ratio = patrolSteps("SUPERVISED") / patrolSteps("RUNNING")
    expect(ratio).toBeGreaterThan(3)
    expect(ratio).toBeLessThan(5)
  })

  it("keeps tracking with reduced force while supervised", () => {
    const sim = new RobotSim(mujoco)
    sim.setMode("SUPERVISED")
    runUntilIdle(sim)
    sim.startPatrol()
    runUntilIdle(sim)
    expect(sim.idle).toBe(true)
  })

  it("can return to work after a stop, with the tray box still usable", () => {
    const sim = new RobotSim(mujoco)
    sim.startMove({ box: 2, slot: 6 })
    for (let i = 0; sim.holding === null; i++) { if (i > 4000) throw new Error("never grabbed"); sim.step(10) }
    sim.setMode("STOPPED")
    runUntilIdle(sim)
    sim.setMode("RUNNING")
    runUntilIdle(sim)
    expect(sim.isValidMove({ box: 2, slot: 6 })).toBe(true)
    sim.startMove({ box: 2, slot: 6 })
    runUntilIdle(sim)
    sim.step(500)
    expect(sim.observation().boxes[2]).toEqual({ at: "slot", slot: 6 })
    const [x, y] = boxPos(sim, 2)
    const [sx, sy] = SLOTS[6]!
    expect(Math.hypot(x - sx, y - sy)).toBeLessThan(0.02)
  })

  it("gives exactly the same result when the same run is repeated", () => {
    const run = () => {
      const sim = new RobotSim(mujoco)
      const hashes: string[] = []
      sim.startMove({ box: 0, slot: 4 })
      sim.step(1500)
      hashes.push(sim.stateHash())
      sim.setMode("SUPERVISED")
      sim.step(3000)
      hashes.push(sim.stateHash())
      sim.setMode("STOPPED")
      sim.step(4000)
      hashes.push(sim.stateHash())
      sim.setMode("RUNNING")
      runUntilIdle(sim)
      sim.startMove({ box: 1, slot: 5 })
      sim.step(2000)
      hashes.push(sim.stateHash())
      return hashes
    }
    expect(run()).toEqual(run())
  })
})
