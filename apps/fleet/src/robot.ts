import {
  type AckIntent,
  type CheckResult,
  GateRunner,
  type GateStore,
  type GateView,
  type Hex,
  type LoadedFile,
  type Mode,
  type Timers,
  type TrustConfig,
} from "@ceasenet/core"
import { type Move, RobotSim, type SimEvent, type SimMode } from "@ceasenet/sim"
import { PlannerInvalidReply, PlannerUnavailable, type Decision, type Planner } from "./planner"
import type { PolicyVersion, Software } from "./software"

export type RobotStatus = Mode | "PAUSED"

/** What a robot does on the network. Separate from its logic, so the logic can be tested offline. */
export interface RobotNet {
  readView(hashes: readonly string[], remembered: readonly Hex[]): Promise<GateView>
  writeLoadout(seq: bigint, files: LoadedFile[]): Promise<void>
  writeHeartbeat(status: RobotStatus, seq: bigint): Promise<void>
  writeAck(intent: AckIntent, artifact: string, newHash?: string): Promise<void>
  extendRecall(key: Hex): Promise<void>
}

export interface DecisionRecord {
  tick: number
  requestId: string
  model: string
  source: Decision["source"]
  provider?: string
  raw: string
  move: Move
  softwareHash: string
  gateMode: Mode
}

export interface RobotOptions {
  id: number
  address: Hex
  sim: RobotSim
  net: RobotNet
  planner: Planner
  trust: TrustConfig
  timers: Timers
  store: GateStore
  software: Software
  /** Fetches and measures a version. Installing refuses anything that does not match the published hash. */
  loadVersion: (version: PolicyVersion) => Software
  autoUpdate: boolean
  startSeq: bigint
  onDecision?: (record: DecisionRecord) => void
  now?: () => number
}

const INVALID_REPLIES_BEFORE_PAUSE = 3
const PLANNER_RETRY_MS = 3_000
const MIN_CHECK_GAP_MS = 1_000

/**
 * One robot: its arm, its safety gate and its planner.
 *
 * The planner only suggests moves. Every move passes the gate first, and the gate can take the arm away
 * from the planner at any moment.
 */
export class RobotRuntime {
  readonly gate: GateRunner
  readonly events: SimEvent[] = []
  readonly decisions: DecisionRecord[] = []
  software: Software
  seq: bigint
  networkUp = true
  plannerEnabled = true
  gateMode: Mode = "RUNNING"
  plannerDown = false
  lastCheck: CheckResult | undefined
  lastError: string | undefined

  private deciding = false
  private checking: Promise<void> | undefined
  private lastCheckAt = -Infinity
  private lastPlannerRetry = -Infinity
  private invalidReplies = 0
  private installing = false
  private readonly opts: RobotOptions

  constructor(opts: RobotOptions) {
    this.opts = opts
    this.software = opts.software
    this.seq = opts.startSeq
    this.gate = new GateRunner({ trust: opts.trust, timers: opts.timers, store: opts.store, now: opts.now })
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  get sim(): RobotSim {
    return this.opts.sim
  }

  get id(): number {
    return this.opts.id
  }

  get address(): Hex {
    return this.opts.address
  }

  /** What the robot is doing right now. The gate outranks everything. */
  get status(): RobotStatus {
    if (this.gateMode !== "RUNNING") return this.gateMode
    return this.plannerDown ? "PAUSED" : "RUNNING"
  }

  private get hashes(): string[] {
    return this.software.files.map((f) => f.hash)
  }

  async start(): Promise<void> {
    await this.opts.net.writeLoadout(this.seq, this.software.files)
    await this.checkGate(true)
    await this.beat()
  }

  /** Advances physics and hands out the next piece of work. Call this often. */
  pump(steps: number): void {
    this.sim.step(steps)
    if (!this.sim.idle) return
    if (this.status === "SUPERVISED") {
      this.record({ tick: this.sim.tick, kind: "PATROL", state: this.sim.stateHash() })
      this.sim.startPatrol()
    } else if (this.status === "RUNNING" && this.plannerEnabledFor()) {
      void this.decide()
    } else if (this.status === "PAUSED") {
      if (this.now() - this.lastPlannerRetry >= PLANNER_RETRY_MS) {
        this.lastPlannerRetry = this.now()
        void this.decide()
      }
    }
  }

  private plannerEnabledFor(): boolean {
    return !this.deciding && !this.installing
  }

  /** Reads Arkiv and applies the result. Runs on a timer and before every task. */
  checkGate(force = false): Promise<void> {
    if (this.checking) return this.checking
    if (!force && this.now() - this.lastCheckAt < MIN_CHECK_GAP_MS) return Promise.resolve()
    this.lastCheckAt = this.now()
    const run = this.runCheck().finally(() => {
      this.checking = undefined
    })
    this.checking = run
    return run
  }

  private async runCheck(): Promise<void> {
    const hashes = this.hashes
    const result = await this.gate.check(hashes, () => {
      if (!this.networkUp) throw new Error("network is down")
      return this.opts.net.readView(hashes, this.gate.rememberedKeys())
    })
    this.lastCheck = result
    this.gateMode = result.decision.mode
    this.applyMode()
    if (result.online) this.afterOnlineCheck(result)
  }

  private afterOnlineCheck(result: CheckResult): void {
    for (const intent of result.acks) {
      void this.sendAck(intent)
    }
    for (const key of result.toExtend) {
      this.opts.net.extendRecall(key).catch((e) => this.note(e))
    }
    if (this.opts.autoUpdate && this.gateMode === "STOPPED" && result.fixes.length > 0) {
      void this.installFix()
    }
  }

  private async sendAck(intent: AckIntent): Promise<void> {
    // Marked first, so a slow write is not repeated by the next check. Un-marked on failure below.
    const id = intent.recall.key + intent.action
    if (this.pendingAcks.has(id)) return
    this.pendingAcks.add(id)
    try {
      await this.opts.net.writeAck(intent, intent.recall.artifact)
      this.gate.markAcked(intent.recall.key, intent.action)
    } catch (e) {
      this.note(e)
    } finally {
      this.pendingAcks.delete(id)
    }
  }

  private readonly pendingAcks = new Set<string>()

  /** Installs the published fix if one applies. Anything that fails its hash check is refused. */
  async installFix(): Promise<boolean> {
    const fix = this.lastCheck?.fixes[0]
    if (!fix || this.installing || !this.networkUp) return false
    this.installing = true
    try {
      const next = this.opts.loadVersion("1.5.3")
      if (next.policyHash.toLowerCase() !== fix.lift.fixedHash?.toLowerCase()) {
        this.lastError = "the fix does not match the published hash, so it was refused"
        return false
      }
      this.software = next
      this.seq += 1n
      await this.opts.net.writeLoadout(this.seq, next.files)
      await this.opts.net.writeAck({ recall: fix.stop, action: "UPDATED" }, fix.stop.artifact, next.policyHash)
      this.gate.markAcked(fix.stop.key, "UPDATED")
      await this.checkGate(true)
      void this.beat()
      return true
    } catch (e) {
      this.note(e)
      return false
    } finally {
      this.installing = false
    }
  }

  async beat(): Promise<void> {
    if (!this.networkUp) return
    try {
      await this.opts.net.writeHeartbeat(this.status, this.seq)
    } catch (e) {
      this.note(e)
    }
  }

  /** Cuts or restores this robot's internet. */
  setNetwork(up: boolean): void {
    this.networkUp = up
    if (up) {
      void this.checkGate(true)
      void this.beat()
    }
  }

  /** Simulates the AI brain becoming unreachable. */
  setPlanner(up: boolean): void {
    this.plannerEnabled = up
  }

  private applyMode(): void {
    const want: SimMode = this.status
    if (this.sim.mode !== want) {
      this.sim.setMode(want)
      this.record({ tick: this.sim.tick, kind: "MODE", mode: want, state: this.sim.stateHash() })
      void this.beat()
    }
  }

  private async decide(): Promise<void> {
    if (this.deciding) return
    this.deciding = true
    try {
      // The gate is checked before every task.
      await this.checkGate()
      if (this.gateMode !== "RUNNING") return

      if (!this.plannerEnabled) throw new PlannerUnavailable("0G is switched off")
      const softwareHash = this.software.policyHash
      const decision = await this.opts.planner.decide(this.sim.observation(), this.software.prompt)

      // Things may have changed during the call. A stale decision is thrown away.
      if (this.plannerDown) {
        this.plannerDown = false
        this.applyMode()
      }
      if (this.gateMode !== "RUNNING" || !this.sim.idle || this.sim.mode !== "RUNNING") return
      if (!this.sim.isValidMove(decision.move)) {
        throw new PlannerInvalidReply(`impossible move ${JSON.stringify(decision.move)}`, decision.raw)
      }

      this.invalidReplies = 0
      const record: DecisionRecord = {
        tick: this.sim.tick,
        requestId: decision.requestId,
        model: decision.model,
        source: decision.source,
        ...(decision.provider ? { provider: decision.provider } : {}),
        raw: decision.raw,
        move: decision.move,
        softwareHash,
        gateMode: this.gateMode,
      }
      this.decisions.push(record)
      this.opts.onDecision?.(record)
      this.record({ tick: this.sim.tick, kind: "MOVE", move: decision.move, state: this.sim.stateHash() })
      this.sim.startMove(decision.move)
    } catch (e) {
      this.onPlannerProblem(e)
    } finally {
      this.deciding = false
    }
  }

  private onPlannerProblem(e: unknown): void {
    this.note(e)
    if (e instanceof PlannerInvalidReply) {
      this.invalidReplies++
      if (this.invalidReplies < INVALID_REPLIES_BEFORE_PAUSE) return
    }
    if (e instanceof PlannerUnavailable || e instanceof PlannerInvalidReply) {
      // No decision means no motion. The robot never makes one up.
      this.plannerDown = true
      this.lastPlannerRetry = this.now()
      this.applyMode()
    } else {
      throw e
    }
  }

  private note(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e)
  }

  private record(event: SimEvent): void {
    this.events.push(event)
  }
}
