import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { LoadedFile, RecallRow } from "@ceasenet/core"
import spawn from "cross-spawn"
import type { CallDecision, Guard } from "./guard"

export interface ProxyCall {
  action: string
  decision: CallDecision
  /** How long the gate took to answer, approval included. */
  gateMs: number
}

/** One call from start to finish: what was asked, what was decided, and what came back. */
export interface FinishedCall {
  action: string
  decision: CallDecision
  args: unknown
  /** What the tool answered. Absent if it was refused, or ended first. */
  result?: unknown
  /** The tool was ended while this was running. */
  ended?: boolean
  ms: number
}

export interface ProxyState {
  /** The tool's process, while one is running. */
  pid?: number
  /** The STOP that shut the tool down, or kept it from starting. */
  recall?: RecallRow
  /** Why this machine will not run the tool, whatever the list says. */
  blockedLocally?: string
}

export interface ProxyOptions {
  guard: Guard
  file: LoadedFile
  command: string
  args: string[]
  cwd?: string
  /** What the tool's process can see. The agent's key must not be in here. */
  env: NodeJS.ProcessEnv
  /** The agent's side of the connection. */
  input: Readable
  output: Writable
  log?: (line: string) => void
  /** Asked before each call. A reason means a person must approve it, even though nothing forbids it. */
  holdReason?: () => string | undefined
  /** Asked before each call and after each check. A reason means this tool must not run on this machine. */
  localBlock?: () => string | undefined
  /** Runs before each decision, so a change made on this machine a moment ago is seen by the very next call. */
  freshen?: () => Promise<void>
  onCall?: (call: ProxyCall) => void
  /** Called once for every call the gate saw, when it is over. */
  onFinished?: (call: FinishedCall) => void
  onState?: (state: ProxyState) => void
}

/** The methods that run code in the tool with something the agent chose. All of them go through the gate. */
const GATED = new Set(["tools/call", "resources/read", "prompts/get"])
const STOP_WAIT_MS = 3_000
const REPLAY_ID = "ceasenet-replay"
const DETAILS_LIMIT = 2_000

type Message = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const idKey = (id: unknown) => JSON.stringify(id)

/** Ends a tool and anything it started. A wrapper such as cmd or uvx must not leave the real server behind. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill())
    return
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      child.kill(name)
    }
  }
  signal("SIGTERM")
  setTimeout(() => signal("SIGKILL"), STOP_WAIT_MS).unref()
}

/**
 * Sits between an agent and an MCP server that runs over stdio.
 *
 * Everything passes through untouched except the methods in {@link GATED}, which reach the tool only if the gate
 * allows it. A refused call is answered as a tool error, not a protocol error, so the agent's model reads the
 * reason and can change course.
 *
 * Refusing calls alone would leave a recalled tool running, free to keep doing whatever it does in the background.
 * So a STOP ends the tool's process, and a tool already under a STOP is never started. The agent stays connected
 * and is answered from here, and when the STOP is lifted the tool starts again and is reintroduced to the agent's
 * session, with nothing for the agent to do.
 */
export class GatedProxy extends EventEmitter {
  private child: ChildProcess | undefined
  private closing = false
  private spawnFailed = false
  /** Requests the tool has been given and not yet answered. */
  private readonly inflight = new Map<string, { id: unknown; method: string; call?: Omit<FinishedCall, "ms" | "result" | "ended"> & { startedAt: number } }>()
  private initializeLine: string | undefined
  private initializedLine: string | undefined
  private lastToolList: unknown
  /** The tools the agent knows about came from here, not from the tool, so it should ask again once it is back. */
  private answeredListLocally = false
  private replay: Promise<void> = Promise.resolve()
  private replayCount = 0
  private finishReplay: (() => void) | undefined
  private firstCheck: Promise<void>
  private resolveFirstCheck!: () => void
  private checked = false
  private queue: Promise<void> = Promise.resolve()
  private cancelChecks: () => void = () => undefined
  private lastStateKey = ""

  constructor(private readonly options: ProxyOptions) {
    super()
    this.firstCheck = new Promise((resolve) => (this.resolveFirstCheck = resolve))
  }

  start(): void {
    const { guard, input } = this.options
    this.cancelChecks = guard.onChecked(() => this.reconcile())
    if (guard.lastCheck) this.reconcile()

    // Requests are handled in order, so a call waiting on the gate cannot be overtaken by the one after it.
    createInterface({ input }).on("line", (line) => {
      this.queue = this.queue
        .then(() => this.handleLine(line))
        .catch((e) => this.log(`could not handle a request: ${(e as Error).message}`))
    })
    input.on("end", () => this.shutdown())
  }

  /** Ends the tool and this proxy. */
  kill(): void {
    this.closing = true
    this.cancelChecks()
    const child = this.child
    this.child = undefined
    if (child) killTree(child)
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  private shutdown(): void {
    this.closing = true
    this.cancelChecks()
    const child = this.child
    if (!child) {
      this.emit("exit", 0)
      return
    }
    // A well-behaved server leaves when its input closes. One that does not is ended.
    child.stdin?.end()
    const timer = setTimeout(() => killTree(child), STOP_WAIT_MS)
    timer.unref()
    child.once("exit", () => clearTimeout(timer))
  }

  /** Makes what is running match what the gate says. Runs after every check. */
  private reconcile(): void {
    if (!this.checked) {
      this.checked = true
      this.resolveFirstCheck()
    }
    if (this.closing) return
    const recall = this.options.guard.stopOn(this.options.file)
    const blockedLocally = this.options.localBlock?.()
    const mustNotRun = Boolean(recall || blockedLocally)
    if (mustNotRun && this.child) {
      this.log(`ending ${this.options.file.name}: ${recall ? recall.reason : blockedLocally}`)
      this.endChild(recall ? "it was recalled" : (blockedLocally ?? "it is blocked"))
    } else if (!mustNotRun && !this.child && !this.spawnFailed) {
      this.startChild()
    }
    this.reportState(recall, blockedLocally)
  }

  private reportState(recall: RecallRow | undefined, blockedLocally: string | undefined): void {
    const key = `${this.child?.pid}:${recall?.key}:${blockedLocally}`
    if (key === this.lastStateKey) return
    this.lastStateKey = key
    this.options.onState?.({ pid: this.child?.pid, recall, blockedLocally })
  }

  private endChild(why: string): void {
    const child = this.child
    this.child = undefined
    if (child) killTree(child)
    this.finishReplay?.()
    for (const { id, method, call } of this.inflight.values()) {
      if (typeof id === "string" && id.startsWith(REPLAY_ID)) continue
      this.refuse(id, method, `CeaseNet ended ${this.options.file.name} while this was running, because ${why}. Do not rely on its result.`)
      if (call) this.finished(call, { ended: true })
    }
    this.inflight.clear()
  }

  private startChild(): void {
    const { command, args, env, cwd } = this.options
    // Its own process group, so that everything it starts can be ended together.
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env,
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    this.child = child
    child.on("error", (e) => {
      if (this.child !== child) return
      this.child = undefined
      this.spawnFailed = true
      this.emit("error", e)
    })
    child.on("exit", (code) => {
      // Anything but the current tool leaving is a tool this proxy ended on purpose.
      if (this.child !== child) {
        if (this.closing) this.emit("exit", code)
        return
      }
      this.child = undefined
      this.emit("exit", code)
    })
    // The proxy answers for a tool that has gone. A broken pipe from its last moments means nothing.
    child.stdin?.on("error", () => undefined)
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (this.child === child) this.fromTool(line)
    })
    if (this.initializeLine) this.replayHandshake()
  }

  /** The agent introduced itself to the tool's last process. The new one needs to hear the same thing. */
  private replayHandshake(): void {
    this.replay = new Promise((resolve) => {
      this.finishReplay = () => {
        this.finishReplay = undefined
        resolve()
      }
      const id = `${REPLAY_ID}-${++this.replayCount}`
      const request = JSON.parse(this.initializeLine!) as Message
      this.inflight.set(idKey(id), { id, method: "initialize" })
      this.write(JSON.stringify({ ...request, id }))
    })
  }

  private fromTool(line: string): void {
    let message: Message | undefined
    try {
      message = JSON.parse(line) as Message
    } catch {
      this.options.output.write(`${line}\n`)
      return
    }
    const isResponse = message && message.method === undefined && message.id !== undefined
    const pending = isResponse ? this.inflight.get(idKey(message!.id)) : undefined
    if (pending) {
      this.inflight.delete(idKey(message!.id))
      if (pending.call) this.finished(pending.call, { result: message!.result ?? { error: message!.error } })
      if (pending.method === "tools/list" && message!.result) this.lastToolList = message!.result
      if (typeof pending.id === "string" && pending.id.startsWith(REPLAY_ID)) {
        this.write(this.initializedLine ?? JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))
        this.finishReplay?.()
        // The agent was told this tool had nothing to offer, which is no longer true.
        if (this.answeredListLocally) {
          this.answeredListLocally = false
          this.options.output.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`)
        }
        return
      }
    }
    this.options.output.write(`${line}\n`)
  }

  private write(line: string): void {
    this.child?.stdin?.write(`${line}\n`)
  }

  private finished(call: Omit<FinishedCall, "ms" | "result" | "ended"> & { startedAt: number }, outcome: { result?: unknown; ended?: boolean } = {}): void {
    const { startedAt, ...rest } = call
    this.options.onFinished?.({ ...rest, ...outcome, ms: Date.now() - startedAt })
  }

  private async handleLine(line: string): Promise<void> {
    await this.firstCheck
    let parsed: Message | Message[]
    try {
      parsed = JSON.parse(line) as Message | Message[]
    } catch {
      this.write(line)
      return
    }
    // A batch goes through the gate one message at a time. It must not be a way around it.
    if (Array.isArray(parsed)) {
      for (const message of parsed) await this.handle(JSON.stringify(message), message)
      return
    }
    await this.handle(line, parsed)
  }

  private async handle(line: string, message: Message): Promise<void> {
    const method = message?.method
    if (method === "initialize") this.initializeLine = line
    if (method === "notifications/initialized") this.initializedLine = line

    let call: Omit<FinishedCall, "ms" | "result" | "ended"> & { startedAt: number } = undefined as never
    if (method && GATED.has(method)) {
      // Something that changes state and expects no answer cannot be refused to anyone, so it does not run.
      if (message.id === undefined) return
      const startedAt = Date.now()
      const { action, decision } = await this.decide(method, message.params)
      call = { action, decision, args: message.params?.arguments ?? message.params ?? {}, startedAt }
      if (!decision.allowed) {
        this.log(`refused ${method}: ${decision.message}`)
        this.refuse(message.id, method, decision.message)
        this.finished(call)
        return
      }
    }

    await this.replay
    if (!this.child) {
      this.answerForTool(message)
      if (call) this.finished(call, { ended: true })
      return
    }
    if (method && message.id !== undefined) this.inflight.set(idKey(message.id), { id: message.id, method, call })
    this.write(line)
  }

  private async decide(method: string, params: Message["params"]): Promise<{ action: string; decision: CallDecision }> {
    const { guard, file, holdReason, localBlock, onCall } = this.options
    const named = String(params?.name ?? params?.uri ?? "unknown")
    const action = method === "tools/call" ? named : `${method} ${named}`
    const details = JSON.stringify(params?.arguments ?? params ?? {}).slice(0, DETAILS_LIMIT)
    const startedAt = Date.now()

    await this.options.freshen?.()
    let decision = await guard.beforeCall(file, action, details)
    // A refusal from the list says why more usefully than anything here, so it is kept as it is.
    if (decision.allowed) {
      const blocked = localBlock?.()
      const reason = holdReason?.()
      if (blocked) decision = { allowed: false, verdict: "BLOCK", message: `CeaseNet refused ${file.name} ${file.version}: ${blocked}` }
      else if (reason && decision.approval === undefined) decision = await guard.holdForHuman(file, action, reason, details)
    }
    this.reconcile()
    onCall?.({ action, decision, gateMs: Date.now() - startedAt })
    return { action, decision }
  }

  private refuse(id: unknown, method: string, text: string): void {
    const reply =
      method === "tools/call"
        ? { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } }
        : { jsonrpc: "2.0", id, error: { code: -32001, message: text } }
    this.options.output.write(`${JSON.stringify(reply)}\n`)
  }

  /** The tool is not running. The agent's session stays up, and hears why when it tries to use it. */
  private answerForTool(message: Message): void {
    const { id, method, params } = message
    if (id === undefined || !method) return
    const { file, guard, localBlock } = this.options
    const why = guard.stopOn(file)?.reason ?? localBlock?.() ?? "it is blocked"
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: file.name, version: file.version },
        instructions: `CeaseNet is not running ${file.name} ${file.version}. Reason: ${why}. Tell the person you are working for, and do not look for a way around it.`,
      },
      ping: {},
      "resources/list": { resources: [] },
      "resources/templates/list": { resourceTemplates: [] },
      "prompts/list": { prompts: [] },
    }
    if (method === "tools/list") {
      if (!this.lastToolList) this.answeredListLocally = true
      results[method] = this.lastToolList ?? { tools: [] }
    }
    const result = results[method]
    const reply =
      result !== undefined
        ? { jsonrpc: "2.0", id, result }
        : { jsonrpc: "2.0", id, error: { code: -32601, message: `${file.name} is not running, because CeaseNet has blocked it. Reason: ${why}` } }
    this.options.output.write(`${JSON.stringify(reply)}\n`)
  }
}

export function runProxy(options: ProxyOptions): GatedProxy {
  const proxy = new GatedProxy(options)
  proxy.start()
  return proxy
}
