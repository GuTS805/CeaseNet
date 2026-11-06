import {
  type AckIntent,
  type AgentStatus,
  type CallVerdict,
  type CheckResult,
  GateRunner,
  type GateStore,
  type GateView,
  type Hex,
  isKillRecall,
  type LoadedFile,
  type Reason,
  type RecallRow,
  type Timers,
  type TrustPolicy,
  lower,
  verdictFor,
} from "@ceasenet/core"

/** What a guard does on the network. Separate from its logic, so the logic can be tested offline. */
export interface GuardNet {
  readView(policy: TrustPolicy, remembered: readonly Hex[]): Promise<GateView>
  writeLoadout(seq: bigint, files: LoadedFile[]): Promise<void>
  writeHeartbeat(status: AgentStatus, seq: bigint): Promise<void>
  writeAck(intent: AckIntent, newHash?: string): Promise<void>
  extendRecall(key: Hex): Promise<void>
}

export type ApprovalResult = "APPROVED" | "DENIED" | "EXPIRED"

export interface ApprovalRequest {
  file: LoadedFile
  action: string
  reason: string
  /** What the call would do, for the person deciding. It stays on this machine. */
  details?: string
}

/** Asks a human. It must honour the signal and answer EXPIRED if the signal fires. */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResult>

export interface CallDecision {
  allowed: boolean
  verdict: CallVerdict
  approval?: ApprovalResult
  /** Why, in words an agent's model can act on. */
  message: string
  recall?: RecallRow
}

export type GuardEvent =
  | { kind: "CALL"; file: LoadedFile; action: string; decision: CallDecision }
  | { kind: "STATUS"; from: AgentStatus; to: AgentStatus }
  | { kind: "RECEIPT"; recall: Hex; action: AckIntent["action"] }
  | { kind: "UPDATE"; from: LoadedFile; to: LoadedFile }
  | { kind: "NETWORK"; up: boolean }

export interface GuardOptions {
  policy: TrustPolicy
  timers: Timers
  store: GateStore
  files: LoadedFile[]
  net: GuardNet
  startSeq: bigint
  approve?: Approver
  onEvent?: (event: GuardEvent) => void
  now?: () => number
}

const MIN_CHECK_GAP_MS = 1_000

/**
 * Stands in front of an agent's tool calls.
 *
 * Every call is checked first. A tool under a STOP is refused, a tool under a confirmed warning needs a human,
 * and if the recall list cannot be read the guard goes through grace, then human approval, then refuses
 * everything. Until the first check has finished nothing is allowed.
 */
export class Guard {
  readonly gate: GateRunner
  files: LoadedFile[]
  seq: bigint
  networkUp = true
  /** The agent cannot reach its AI model, so it is not acting. Reported in the heartbeat. */
  paused = false
  lastCheck: CheckResult | undefined
  lastError: string | undefined

  private checking: Promise<void> | undefined
  private lastCheckAt = -Infinity
  private readonly pendingAcks = new Set<string>()
  private lastStatus: AgentStatus = "RUNNING"
  private readonly opts: GuardOptions
  private readonly checkListeners = new Set<() => void>()
  private readonly reports = new Set<Promise<void>>()

  constructor(opts: GuardOptions) {
    this.opts = opts
    this.files = [...opts.files]
    this.seq = opts.startSeq
    this.gate = new GateRunner({ policy: opts.policy, timers: opts.timers, store: opts.store, now: opts.now })
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** What the agent as a whole may do. One blocked tool does not change this. */
  get status(): AgentStatus {
    const core = this.lastCheck?.decision.core.mode
    if (core && core !== "RUNNING") return core
    return this.paused ? "PAUSED" : "RUNNING"
  }

  /** What each loaded tool may do right now. */
  get toolVerdicts(): { file: LoadedFile; verdict: CallVerdict }[] {
    return this.files
      .filter((f) => f.kind === "tool" || f.kind === "skill")
      .map((file) => ({ file, verdict: this.lastCheck ? verdictFor(this.lastCheck.decision, file.hash) : "BLOCK" }))
  }

  /** The STOP in force on this file or on the agent itself, if any. Being offline is not a STOP. */
  stopOn(file: LoadedFile): RecallRow | undefined {
    const decision = this.lastCheck?.decision
    if (!decision) return undefined
    const tool = decision.tools.find((t) => lower(t.file.hash) === lower(file.hash))
    return decision.core.activeStops[0] ?? tool?.decision.activeStops[0]
  }

  /** Called after every reading of the list. Returns a function that cancels it. */
  onChecked(listener: () => void): () => void {
    this.checkListeners.add(listener)
    return () => void this.checkListeners.delete(listener)
  }

  /** Replaces what this agent has loaded, and publishes the change. */
  async setFiles(files: LoadedFile[]): Promise<void> {
    this.files = [...files]
    this.seq += 1n
    await this.opts.net.writeLoadout(this.seq, this.files)
    await this.check(true)
  }

  /** Publishes what this agent has loaded and takes the first reading. */
  async start(): Promise<void> {
    await this.opts.net.writeLoadout(this.seq, this.files)
    await this.check(true)
    await this.beat()
  }

  /** Reads the recall list and applies the result. Runs on a timer and before every call. */
  check(force = false): Promise<void> {
    // A read already under way may have started before whatever prompted this one, so a forced check waits and reads again.
    if (this.checking) return force ? this.checking.then(() => this.check(true)) : this.checking
    if (!force && this.now() - this.lastCheckAt < MIN_CHECK_GAP_MS) return Promise.resolve()
    this.lastCheckAt = this.now()
    const run = this.runCheck().finally(() => {
      this.checking = undefined
    })
    this.checking = run
    return run
  }

  private async runCheck(): Promise<void> {
    const result = await this.gate.check(this.files, (policy, remembered) => {
      if (!this.networkUp) throw new Error("network is down")
      return this.opts.net.readView(policy, remembered)
    })
    this.lastCheck = result
    this.noteStatus()
    for (const listener of this.checkListeners) listener()
    if (!result.online) return
    for (const intent of result.acks) this.track(this.sendAck(intent))
    for (const key of result.toExtend) this.opts.net.extendRecall(key).catch((e) => this.note(e))
  }

  private noteStatus(): void {
    const to = this.status
    if (to === this.lastStatus) return
    this.opts.onEvent?.({ kind: "STATUS", from: this.lastStatus, to })
    this.lastStatus = to
    void this.beat()
  }

  private track(report: Promise<void>): void {
    this.reports.add(report)
    void report.finally(() => this.reports.delete(report))
  }

  /** Waits for receipts already on their way, so something shutting down does not leave them unsent. */
  async settle(): Promise<void> {
    while (this.reports.size > 0) await Promise.allSettled([...this.reports])
  }

  private async sendAck(intent: AckIntent): Promise<void> {
    const id = intent.recall.key + intent.action
    // Marked first, so a slow write is not repeated by the next check.
    if (this.pendingAcks.has(id)) return
    this.pendingAcks.add(id)
    try {
      await this.opts.net.writeAck(intent)
      this.gate.markAcked(intent.recall.key, intent.action)
      this.opts.onEvent?.({ kind: "RECEIPT", recall: intent.recall.key, action: intent.action })
    } catch (e) {
      this.note(e)
    } finally {
      this.pendingAcks.delete(id)
    }
  }

  /** Decides one tool call. Nothing reaches the tool unless this says so. */
  async beforeCall(file: LoadedFile, action: string, details?: string): Promise<CallDecision> {
    await this.check()
    let decision = this.decide(file)

    if (decision.verdict === "NEEDS_APPROVAL") {
      decision = await this.askHuman(file, action, decision, details)
    }
    this.opts.onEvent?.({ kind: "CALL", file, action, decision })
    return decision
  }

  /** A call the gate allows, that its owner has asked to approve anyway. A STOP still wins over any answer. */
  async holdForHuman(file: LoadedFile, action: string, reason: string, details?: string): Promise<CallDecision> {
    const needed: CallDecision = { allowed: false, verdict: "NEEDS_APPROVAL", message: reason }
    const decision = await this.askHuman(file, action, needed, details)
    this.opts.onEvent?.({ kind: "CALL", file, action, decision })
    return decision
  }

  private decide(file: LoadedFile): CallDecision {
    if (!this.lastCheck) {
      return { allowed: false, verdict: "BLOCK", message: "CeaseNet has not been able to read the recall list yet." }
    }
    // Only a file this guard measured can be allowed, whatever the caller says it is.
    const known = this.files.some((f) => lower(f.hash) === lower(file.hash))
    const verdict = known ? verdictFor(this.lastCheck.decision, file.hash) : "BLOCK"
    if (verdict === "ALLOW") return { allowed: true, verdict, message: "Allowed." }

    const reasons = [
      ...this.lastCheck.decision.core.reasons,
      ...(this.lastCheck.decision.tools.find((t) => lower(t.file.hash) === lower(file.hash))?.decision.reasons ?? []),
    ]
    const main = reasons.find((r) => r.type !== "CLEAR" && r.type !== "OFFLINE_GRACE")
    const recall = main && "recall" in main ? main.recall : undefined
    const name = `${file.name} ${file.version}`
    return {
      allowed: false,
      verdict,
      recall,
      message: !known ? `CeaseNet refused ${name}: this file was never measured.` : describe(name, verdict, main),
    }
  }

  private async askHuman(file: LoadedFile, action: string, needed: CallDecision, details?: string): Promise<CallDecision> {
    const approve = this.opts.approve
    if (!approve) return { ...needed, message: `${needed.message} Nobody is set up to approve it, so it is refused.` }

    // A STOP arriving while the human decides ends the wait. The agent must not sit waiting on something refused.
    const abort = new AbortController()
    const watch = setInterval(() => {
      if (this.decide(file).verdict === "BLOCK") abort.abort()
    }, 500)
    let approval: ApprovalResult
    try {
      approval = await approve({ file, action, reason: needed.message, details }, abort.signal)
    } finally {
      clearInterval(watch)
    }

    // The answer may have taken a while, so the gate has the last word.
    await this.check(true)
    const now = this.decide(file)
    if (now.verdict === "BLOCK") return { ...now, approval }
    if (approval === "APPROVED") return { allowed: true, verdict: now.verdict, approval, recall: needed.recall, message: "A human approved this call." }
    return {
      ...needed,
      allowed: false,
      approval,
      message: approval === "DENIED" ? `A human refused this call. ${needed.message}` : `Nobody approved this call in time. ${needed.message}`,
    }
  }

  /** Moves to a published fix. Anything that does not match the published hash is refused. */
  async adoptFix(fix: CheckResult["fixes"][number], next: LoadedFile): Promise<boolean> {
    if (lower(next.hash) !== lower(fix.lift.fixedHash ?? "")) {
      this.lastError = `${next.name} ${next.version} does not match the published fix, so it was refused`
      return false
    }
    const from = this.files.find((f) => lower(f.hash) === lower(fix.file.hash))
    if (!from) return false
    this.files = this.files.map((f) => (f === from ? next : f))
    this.seq += 1n
    this.opts.onEvent?.({ kind: "UPDATE", from, to: next })
    try {
      await this.opts.net.writeLoadout(this.seq, this.files)
      await this.opts.net.writeAck({ recall: fix.stop, action: "UPDATED" }, next.hash)
      this.gate.markAcked(fix.stop.key, "UPDATED")
    } catch (e) {
      this.note(e)
    }
    await this.check(true)
    void this.beat()
    return true
  }

  async beat(status: AgentStatus = this.status): Promise<void> {
    if (!this.networkUp) return
    try {
      await this.opts.net.writeHeartbeat(status, this.seq)
    } catch (e) {
      this.note(e)
    }
  }

  /** Cuts or restores this agent's connection to the recall list. */
  setNetwork(up: boolean): void {
    this.networkUp = up
    this.opts.onEvent?.({ kind: "NETWORK", up })
    if (up) {
      void this.check(true)
      void this.beat()
    }
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.noteStatus()
  }

  /** Keeps reading the recall list and beating, until the returned function is called. */
  run(offsetMs = 0): () => void {
    const { checkIntervalMs, heartbeatIntervalMs } = this.opts.timers
    const timers: ReturnType<typeof setInterval>[] = []
    const later = setTimeout(() => {
      timers.push(
        setInterval(() => void this.check().catch((e) => this.note(e)), checkIntervalMs),
        setInterval(() => void this.beat(), heartbeatIntervalMs),
      )
    }, offsetMs)
    return () => {
      clearTimeout(later)
      timers.forEach(clearInterval)
    }
  }

  private note(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e)
  }
}

/** People write reasons with or without a full stop. Either way it should read as a sentence. */
const sentence = (text: string): string => (/[.!?]\s*$/.test(text) ? text.trim() : `${text.trim()}.`)

function describe(name: string, verdict: CallVerdict, reason: Reason | undefined): string {
  const refused = verdict === "BLOCK"
  if (reason?.type === "STOP" && isKillRecall(reason.recall.artifact)) {
    return `CeaseNet refused ${name}: the owner of this agent has stopped it. Reason: ${sentence(reason.recall.reason)} Do not try this or any other tool again until a person restarts it.`
  }
  if (reason?.type === "STOP") {
    const advice = reason.recall.advice ? ` What to do: ${sentence(reason.recall.advice)}` : ""
    return `CeaseNet blocked ${name}: it was recalled by ${reason.recall.creator}. Reason: ${sentence(reason.recall.reason)}${advice} Do not use this tool again.`
  }
  if (reason?.type === "CONFIRMED_ADVISORY") {
    return `CeaseNet needs a human to approve ${name}: verified people have confirmed a warning about it. Reason: ${reason.recall.reason}.`
  }
  if (reason?.type === "OFFLINE_SUPERVISED") {
    return `CeaseNet cannot reach the recall list, so a human must approve ${name} until it can.`
  }
  if (reason?.type === "OFFLINE_STOP") {
    return `CeaseNet has not been able to reach the recall list for too long, so ${name} is refused until it can.`
  }
  return refused ? `CeaseNet refused ${name}.` : `CeaseNet needs a human to approve ${name}.`
}
