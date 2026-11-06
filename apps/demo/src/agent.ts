import { canonicalJson, hashBytes, type LoadedFile } from "@ceasenet/core"
import { type CallResult, Guard, GuardedTool, type ToolProcess, type ToolSpec } from "@ceasenet/guard"
import { type Brain, BrainUnavailable, type Message } from "./brain"
import type { ToolPackage } from "./catalog"

export type FeedKind = "job" | "allowed" | "blocked" | "approved" | "refused" | "said" | "problem" | "update"

export interface FeedItem {
  id: number
  at: number
  kind: FeedKind
  text: string
  /** The model request that led to this, when there was one. */
  requestId?: string
}

/** Runs one tool call without the network: real in the demo, faked in tests. */
export interface ToolConnection {
  file: LoadedFile
  specs: ToolSpec[]
  call(name: string, args: Record<string, unknown>): Promise<CallResult>
  close(): Promise<void>
}

export type Connect = (pkg: ToolPackage) => Promise<ToolConnection>

export const connectWith =
  (guard: Guard, process: (pkg: ToolPackage) => ToolProcess): Connect =>
  (pkg) =>
    GuardedTool.connect(guard, pkg.file, process(pkg))

export interface AgentOptions {
  id: string
  company: string
  guard: Guard
  brain: Brain
  systemPrompt: string
  tools: ToolPackage[]
  connect: Connect
  /** Finds the published version for a fix. */
  findFix: (hash: string) => ToolPackage | undefined
  autoUpdate: boolean
  /** Called for every step, so the diary can keep the model request behind each call. */
  onCall?: (info: { file: LoadedFile; action: string; args: Record<string, unknown>; result: CallResult; requestId: string; model: string }) => void
  maxTurns?: number
  turnGapMs?: number
  firstInvoice?: number
  wait?: (ms: number) => Promise<void>
}

const FEED_LIMIT = 60
const RETRY_MS = 3_000

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A real agent loop: a model chooses each step, and tools run as separate MCP server processes.
 * Every tool call goes through the guard. Nothing in here can reach a tool any other way.
 */
export class OfficeAgent {
  readonly feed: FeedItem[] = []
  connections: ToolConnection[] = []
  jobs = 0
  brainProblem: string | undefined
  private nextFeedId = 1
  private invoice: number
  private running = false
  private updating = false
  private loop: Promise<void> | undefined
  private readonly wait: (ms: number) => Promise<void>

  constructor(readonly opts: AgentOptions) {
    this.invoice = opts.firstInvoice ?? 1000
    this.wait = opts.wait ?? pause
  }

  get id(): string {
    return this.opts.id
  }

  get guard(): Guard {
    return this.opts.guard
  }

  private say(kind: FeedKind, text: string, requestId?: string): void {
    this.feed.push({ id: this.nextFeedId++, at: Date.now(), kind, text, requestId })
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT)
  }

  async start(): Promise<void> {
    this.connections = await Promise.all(this.opts.tools.map((t) => this.opts.connect(t)))
    await this.guard.start()
    this.running = true
    this.loop = this.runLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop
    await Promise.allSettled(this.connections.map((c) => c.close()))
  }

  private get specs(): ToolSpec[] {
    return this.connections.flatMap((c) => c.specs)
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      if (this.opts.autoUpdate) await this.installFix()
      if (this.guard.status === "STOPPED") {
        await this.wait(1000)
        continue
      }
      await this.runJob()
    }
  }

  /** One job. Returns early if the agent is stopped, or the model is out of reach. */
  async runJob(): Promise<void> {
    const job = `INV-${this.invoice}`
    this.invoice += 1
    this.say("job", `New job: invoice ${job}`)
    const messages: Message[] = [
      { role: "system", content: this.opts.systemPrompt },
      { role: "user", content: `Job: invoice ${job}` },
    ]

    const maxTurns = this.opts.maxTurns ?? 6
    for (let turn = 0; turn < maxTurns && this.running; turn++) {
      if (this.guard.status === "STOPPED") return
      const reply = await this.think(messages)
      if (!reply) return
      messages.push(reply.message)

      const calls = reply.message.tool_calls ?? []
      if (calls.length === 0) {
        this.jobs += 1
        this.say("said", reply.message.content ?? "Done.", reply.requestId)
        return
      }
      for (const call of calls) {
        const text = await this.runTool(call.function.name, call.function.arguments, reply.requestId, reply.model)
        messages.push({ role: "tool", tool_call_id: call.id, content: text })
      }
      if (this.opts.turnGapMs) await this.wait(this.opts.turnGapMs)
    }
  }

  private async think(messages: readonly Message[]) {
    while (this.running) {
      try {
        const reply = await this.opts.brain.next(messages, this.specs)
        this.brainProblem = undefined
        this.guard.setPaused(false)
        return reply
      } catch (e) {
        if (!(e instanceof BrainUnavailable)) throw e
        // No model means no decision. The agent waits and never makes one up.
        this.brainProblem = e.message
        this.guard.setPaused(true)
        this.say("problem", "Cannot reach the AI model, so the agent is waiting.")
        await this.wait(RETRY_MS)
      }
    }
    return undefined
  }

  private async runTool(name: string, rawArgs: string, requestId: string, model: string): Promise<string> {
    const connection = this.connections.find((c) => c.specs.some((s) => s.name === name))
    if (!connection) return `There is no tool called ${name}.`

    let args: Record<string, unknown>
    try {
      args = JSON.parse(rawArgs || "{}") as Record<string, unknown>
    } catch {
      return `The arguments for ${name} were not valid JSON.`
    }

    const label = `${connection.file.name} ${connection.file.version}`
    const result = await connection.call(name, args)
    this.opts.onCall?.({ file: connection.file, action: name, args, result, requestId, model })
    if (!result.decision.allowed) {
      const approval = result.decision.approval
      if (approval === "DENIED") this.say("refused", `${name} refused by a human`, requestId)
      else if (approval === "EXPIRED") this.say("refused", `${name} not approved in time`, requestId)
      else this.say("blocked", `BLOCKED ${name} (${label})`, requestId)
    } else if (result.decision.approval === "APPROVED") {
      this.say("approved", `${name} ran after a human approved it (${label})`, requestId)
    } else {
      this.say("allowed", `${name} (${label})`, requestId)
    }
    return result.text
  }

  /** Moves to a published fix, if one applies. The guard refuses anything that does not match the published hash. */
  async installFix(): Promise<boolean> {
    const fix = this.guard.lastCheck?.fixes[0]
    if (!fix || this.updating || !this.guard.networkUp) return false
    const next = this.opts.findFix(fix.lift.fixedHash ?? "")
    if (!next) return false
    this.updating = true
    try {
      const fresh = await this.opts.connect(next)
      const adopted = await this.guard.adoptFix(fix, next.file)
      if (!adopted) {
        await fresh.close()
        return false
      }
      const old = this.connections.find((c) => c.file.hash === fix.file.hash)
      this.connections = this.connections.map((c) => (c === old ? fresh : c))
      await old?.close()
      this.say("update", `Moved to ${next.file.name} ${next.file.version}, the published fix`)
      return true
    } finally {
      this.updating = false
    }
  }
}

/** Arguments can hold private content, so the diary keeps only their hash. */
export const argsHash = (args: Record<string, unknown>) => hashBytes(canonicalJson(args))
