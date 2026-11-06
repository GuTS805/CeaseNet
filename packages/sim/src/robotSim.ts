import { exactAcos, exactAtan2, exactHypot } from "./exactMath"
import { BOX_COUNT, BOX_SIZE, LINK, SCENE_XML, SHOULDER_HEIGHT, SLOTS, TABLE_TOP, TOOL_LENGTH, TRAY } from "./scene"

export type SimMode = "RUNNING" | "SUPERVISED" | "STOPPED" | "PAUSED"

export interface Move {
  box: number
  slot: number
}

export type BoxPlace = { at: "slot"; slot: number } | { at: "tray"; index: number } | { at: "hand" }

export interface Observation {
  boxes: BoxPlace[]
  freeSlots: number[]
  holding: number | null
  /** The box moved last, so a planner with no memory can work through all of them. */
  lastMoved: number | null
}

/** Speed and force limits for each mode. Motion itself always stays on the robot. */
export const LIMITS: Record<SimMode, { speed: number; force: number }> = {
  RUNNING: { speed: 1, force: 1 },
  SUPERVISED: { speed: 0.25, force: 0.35 },
  STOPPED: { speed: 0.5, force: 0.5 },
  PAUSED: { speed: 0.5, force: 0.5 },
}

const MAX_JOINT_SPEED = 1.8 // radians per second at full speed
const HOVER = 0.4
const HOME = { x: 0.22, y: 0, z: 0.56 }
const ARRIVED = 0.012 // radians
const FORCE_LIMIT = 90

type Step =
  | { kind: "goto"; x: number; y: number; z: number }
  | { kind: "grab"; box: number }
  | { kind: "release"; place: BoxPlace }

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

/** Solves the arm for a tool tip position, keeping the tool pointing straight down. */
export function solveArm(x: number, y: number, z: number): [number, number, number, number] {
  const r = exactHypot(x, y)
  const wz = z + TOOL_LENGTH - SHOULDER_HEIGHT
  const reach = 2 * LINK - 1e-4
  const d = Math.min(exactHypot(r, wz), reach)
  const cosElbow = Math.max(-1, Math.min(1, (d * d - 2 * LINK * LINK) / (2 * LINK * LINK)))
  const elbow = exactAcos(cosElbow)
  // With two links of equal length, the angle between the upper arm and the wrist is half the elbow angle.
  const shoulder = exactAtan2(r, wz) - elbow / 2
  return [exactAtan2(y, x), shoulder, elbow, -(shoulder + elbow)]
}

/** Each loaded engine has its own file system, so the scene is written once per engine. */
const enginesWithScene = new WeakSet<object>()

/**
 * One robot's physics and motion. Works the same in Node and the browser, so a recorded run can be
 * replayed anywhere and checked step by step.
 *
 * Everything advances in whole physics steps from commands issued at known steps, so the same commands
 * always produce the same motion.
 */
export class RobotSim {
  readonly model: any
  readonly data: any
  tick = 0
  mode: SimMode = "RUNNING"
  private readonly boxes: BoxPlace[] = []
  private readonly boxQpos: number[] = []
  private readonly boxDof: number[] = []
  private readonly tipSite: number
  private target: [number, number, number, number]
  private goal: [number, number, number, number]
  private plan: Step[] = []
  private lastMoved: number | null = null
  private readonly mj: any

  constructor(mujoco: unknown) {
    const mj = mujoco as any
    this.mj = mj
    if (!enginesWithScene.has(mj)) {
      mj.FS.mkdir("/ceasenet")
      mj.FS.writeFile("/ceasenet/cell.xml", SCENE_XML)
      enginesWithScene.add(mj)
    }
    this.model = mj.MjModel.mj_loadXML("/ceasenet/cell.xml")
    this.data = new mj.MjData(this.model)
    this.tipSite = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_SITE.value, "tip")
    for (let i = 0; i < BOX_COUNT; i++) {
      const joint = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_JOINT.value, `box${i}`)
      this.boxQpos.push(this.model.jnt_qposadr[joint])
      this.boxDof.push(this.model.jnt_dofadr[joint])
      this.boxes.push({ at: "slot", slot: i })
    }
    const home = solveArm(HOME.x, HOME.y, HOME.z)
    this.target = [...home]
    this.goal = [...home]
    for (let j = 0; j < 4; j++) {
      this.data.qpos[j] = home[j]!
      this.data.ctrl[j] = home[j]!
    }
    mj.mj_forward(this.model, this.data)
  }

  /** True when the arm has finished everything it was asked to do. */
  get idle(): boolean {
    return this.plan.length === 0 && this.settled()
  }

  get holding(): number | null {
    const i = this.boxes.findIndex((b) => b.at === "hand")
    return i === -1 ? null : i
  }

  observation(): Observation {
    const taken = new Set(this.boxes.flatMap((b) => (b.at === "slot" ? [b.slot] : [])))
    return {
      boxes: this.boxes.map((b) => ({ ...b })),
      freeSlots: SLOTS.map((_, i) => i).filter((i) => !taken.has(i)),
      holding: this.holding,
      lastMoved: this.lastMoved,
    }
  }

  /** Checks a planner's decision against what is physically possible. */
  isValidMove(m: Move): boolean {
    if (!Number.isInteger(m.box) || !Number.isInteger(m.slot)) return false
    if (m.box < 0 || m.box >= BOX_COUNT || m.slot < 0 || m.slot >= SLOTS.length) return false
    if (this.boxes[m.box]?.at === "hand") return false
    return this.observation().freeSlots.includes(m.slot)
  }

  /** Starts a move. Only allowed at full operation with nothing in hand. */
  startMove(m: Move): void {
    if (this.mode !== "RUNNING") throw new Error(`cannot start a move while ${this.mode}`)
    if (!this.idle) throw new Error("arm is busy")
    if (!this.isValidMove(m)) throw new Error(`invalid move ${JSON.stringify(m)}`)
    this.lastMoved = m.box
    const [fx, fy, fz] = this.boxTop(m.box)
    const [tx, ty] = SLOTS[m.slot]!
    const placeZ = TABLE_TOP + BOX_SIZE + 0.002
    this.plan = [
      { kind: "goto", x: fx, y: fy, z: HOVER },
      { kind: "goto", x: fx, y: fy, z: fz },
      { kind: "grab", box: m.box },
      { kind: "goto", x: fx, y: fy, z: HOVER },
      { kind: "goto", x: tx, y: ty, z: HOVER },
      { kind: "goto", x: tx, y: ty, z: placeZ },
      { kind: "release", place: { at: "slot", slot: m.slot } },
      { kind: "goto", x: tx, y: ty, z: HOVER },
    ]
  }

  /**
   * Changes mode and applies its limits. Anything held is put down on the tray first.
   *
   * Going back to RUNNING only lifts the limits; it never resumes an old motion.
   */
  setMode(mode: SimMode): void {
    if (mode === this.mode) return
    this.mode = mode
    const limits = LIMITS[mode]
    for (let a = 0; a < this.model.nu; a++) {
      const range = FORCE_LIMIT * limits.force
      this.model.actuator_forcerange[2 * a] = -range
      this.model.actuator_forcerange[2 * a + 1] = range
    }
    if (mode === "RUNNING") {
      // A plan cut short may have left a box in hand. Settle that before taking new work.
      this.plan = this.holding === null ? [] : this.putDownPlan()
      return
    }
    this.plan = [...this.putDownPlan(), this.homeStep()]
  }

  /** A slow patrol with nothing in hand, used while supervised. */
  startPatrol(): void {
    if (!this.idle) return
    const phase = Math.floor(this.tick / 4000) % 2
    this.plan = [
      { kind: "goto", x: 0.42, y: phase === 0 ? 0.2 : -0.2, z: 0.46 },
      this.homeStep(),
    ]
  }

  /** Advances the physics. Commands issued between calls take effect at a known step. */
  step(count = 1): void {
    const dtMax = (MAX_JOINT_SPEED * LIMITS[this.mode].speed * this.model.opt.timestep) as number
    for (let n = 0; n < count; n++) {
      this.advancePlan()
      for (let j = 0; j < 4; j++) {
        const delta = this.goal[j]! - this.target[j]!
        this.target[j]! += Math.max(-dtMax, Math.min(dtMax, delta))
        this.data.ctrl[j] = this.target[j]!
      }
      this.mj.mj_step(this.model, this.data)
      this.carry()
      this.tick++
    }
  }

  /** A fingerprint of the exact physical state, used to prove a replay matches the original run. */
  stateHash(): string {
    let h = FNV_OFFSET
    const bytes = new Uint8Array(new Float64Array(this.data.qpos).buffer)
    for (const b of bytes) {
      h ^= BigInt(b)
      h = (h * FNV_PRIME) & MASK
    }
    return h.toString(16).padStart(16, "0")
  }

  qpos(): number[] {
    return Array.from(this.data.qpos as Float64Array)
  }

  /** Shows a recorded pose without running physics. Used by the viewer. */
  showPose(qpos: ArrayLike<number>): void {
    for (let i = 0; i < qpos.length; i++) this.data.qpos[i] = qpos[i]!
    this.mj.mj_kinematics(this.model, this.data)
  }

  private boxTop(i: number): [number, number, number] {
    const a = this.boxQpos[i]!
    return [this.data.qpos[a], this.data.qpos[a + 1], this.data.qpos[a + 2] + BOX_SIZE / 2 + 0.002]
  }

  private homeStep(): Step {
    return { kind: "goto", ...HOME }
  }

  private putDownPlan(): Step[] {
    const tip = this.tip()
    const lift: Step = { kind: "goto", x: tip[0], y: tip[1], z: Math.max(tip[2], HOVER) }
    if (this.holding === null) return [lift]
    const index = this.boxes.filter((b) => b.at === "tray").length
    const [x, y] = TRAY[index % TRAY.length]!
    const layer = Math.floor(index / TRAY.length)
    return [
      lift,
      { kind: "goto", x, y, z: HOVER },
      { kind: "goto", x, y, z: TABLE_TOP + 0.004 + BOX_SIZE * (layer + 1) + 0.002 },
      { kind: "release", place: { at: "tray", index } },
      { kind: "goto", x, y, z: HOVER },
    ]
  }

  private tip(): [number, number, number] {
    const p = this.data.site_xpos
    const s = this.tipSite * 3
    return [p[s], p[s + 1], p[s + 2]]
  }

  private settled(): boolean {
    for (let j = 0; j < 4; j++) {
      if (Math.abs(this.goal[j]! - this.data.qpos[j]) > ARRIVED) return false
    }
    return true
  }

  private advancePlan(): void {
    const step = this.plan[0]
    if (!step) return
    if (step.kind === "grab") {
      this.boxes[step.box] = { at: "hand" }
      this.plan.shift()
      return
    }
    if (step.kind === "release") {
      const held = this.holding
      if (held !== null) this.boxes[held] = step.place
      this.plan.shift()
      return
    }
    const goal = solveArm(step.x, step.y, step.z)
    if (goal.some((v, j) => v !== this.goal[j])) this.goal = goal
    if (this.settled()) this.plan.shift()
  }

  /** A held box rides on the gripper. Contact grasping is not what this demo is about. */
  private carry(): void {
    const held = this.holding
    if (held === null) return
    const a = this.boxQpos[held]!
    const v = this.boxDof[held]!
    const [x, y, z] = this.tip()
    this.data.qpos[a] = x
    this.data.qpos[a + 1] = y
    this.data.qpos[a + 2] = z - BOX_SIZE / 2 - 0.002
    this.data.qpos[a + 3] = 1
    this.data.qpos[a + 4] = 0
    this.data.qpos[a + 5] = 0
    this.data.qpos[a + 6] = 0
    for (let i = 0; i < 6; i++) this.data.qvel[v + i] = 0
  }
}
