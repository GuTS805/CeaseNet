import { type ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { LoadedFile } from "@ceasenet/core"
import type { Guard } from "./guard"

export interface ProxyOptions {
  guard: Guard
  file: LoadedFile
  command: string
  args: string[]
  /** What the tool's process can see. The agent's key must not be in here. */
  env: NodeJS.ProcessEnv
  /** The agent's side of the connection. */
  input: Readable
  output: Writable
  log?: (line: string) => void
}

export interface ToolVersion {
  file: LoadedFile
  command: string
  args: string[]
}

/** How long a replacement tool has to start and answer. */
const SWAP_TIMEOUT_MS = 30_000
const SWAP_REQUEST_ID = "ceasenet-swap"

/**
 * Sits between an agent and an MCP server that runs over stdio.
 *
 * Everything passes through untouched except `tools/call`, which goes to the tool only if the gate allows it.
 * A refused call is answered as a tool error, not a protocol error, so the agent's model reads the reason and
 * can change course.
 *
 * It emits "exit" and "error" for the tool it is currently running.
 */
export class ProxyRun extends EventEmitter {
  private child: ChildProcess
  private file: LoadedFile
  /** The agent's own `initialize` request, so a replacement tool can be started the same way. */
  private initialize: Record<string, unknown> | undefined
  private starting: { child: ChildProcess; ready: () => void; failed: (e: Error) => void } | undefined
  // Requests are handled in order, so a call waiting on the gate cannot be overtaken by the one after it.
  private queue: Promise<void> = Promise.resolve()
  private readonly log: (line: string) => void

  constructor(private readonly options: ProxyOptions) {
    super()
    this.file = options.file
    this.log = options.log ?? (() => undefined)
    this.child = this.startTool(options.command, options.args)
    createInterface({ input: options.input }).on("line", (line) => {
      this.queue = this.queue.then(() => this.handle(line)).catch((e) => this.log(`could not handle a request: ${(e as Error).message}`))
    })
    options.input.on("end", () => this.child.stdin!.end())
  }

  /** The tool's version now in front of the agent. */
  get current(): LoadedFile {
    return this.file
  }

  kill(): void {
    this.child.kill()
  }

  private startTool(command: string, args: string[]): ChildProcess {
    // stdout carries the protocol, so the tool's own messages go to stderr.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: this.options.env })
    createInterface({ input: child.stdout! }).on("line", (line) => this.fromTool(child, line))
    // Only the tool in front of the agent counts. An old version ending after a swap is not news.
    child.on("exit", (code, signal) => {
      if (child === this.child) this.emit("exit", code, signal)
    })
    child.on("error", (e) => {
      if (this.starting?.child === child) this.starting.failed(e)
      else if (child === this.child) this.emit("error", e)
    })
    return child
  }

  private fromTool(child: ChildProcess, line: string): void {
    if (this.starting?.child === child) {
      // A replacement answers its start-up here. The agent already did this once and must not see it again.
      try {
        if ((JSON.parse(line) as { id?: unknown }).id === SWAP_REQUEST_ID) this.starting.ready()
      } catch {
        // Not a protocol message, so it is not the answer being waited for.
      }
      return
    }
    if (child === this.child) this.options.output.write(`${line}\n`)
  }

  private forward(line: string): void {
    this.child.stdin!.write(`${line}\n`)
  }

  private async handle(line: string): Promise<void> {
    let message: { id?: unknown; method?: string; params?: { name?: unknown } }
    try {
      message = JSON.parse(line)
    } catch {
      this.forward(line)
      return
    }
    if (message?.method === "initialize") this.initialize = message as Record<string, unknown>
    if (message?.method !== "tools/call") {
      this.forward(line)
      return
    }
    const action = String(message.params?.name ?? "unknown")
    const decision = await this.options.guard.beforeCall(this.file, action)
    if (decision.allowed) {
      this.forward(line)
      return
    }
    this.log(`refused ${action}: ${decision.message}`)
    this.options.output.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: true, content: [{ type: "text", text: decision.message }] },
      })}\n`,
    )
  }

  /**
   * Puts another version in front of the agent without it noticing: the new tool is started and greeted the way
   * the agent greeted the old one, and only then takes over. If it does not come up, the old one stays where it is.
   * Requests wait in line meanwhile. The caller must have checked this is the version it means to run.
   */
  swap(next: ToolVersion): Promise<void> {
    const run = this.queue.then(() => this.replaceTool(next))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async replaceTool(next: ToolVersion): Promise<void> {
    const fresh = this.startTool(next.command, next.args)
    try {
      if (this.initialize) await this.greet(fresh, this.initialize)
    } catch (e) {
      this.starting = undefined
      fresh.kill()
      throw e
    }
    this.starting = undefined
    const old = this.child
    this.child = fresh
    this.file = next.file
    old.kill()
  }

  private greet(child: ChildProcess, initialize: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the new version did not answer in time")), SWAP_TIMEOUT_MS)
      const gone = () => reject(new Error("the new version stopped while starting"))
      child.once("exit", gone)
      this.starting = {
        child,
        ready: () => {
          clearTimeout(timer)
          child.off("exit", gone)
          child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
          resolve()
        },
        failed: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      child.stdin!.write(`${JSON.stringify({ ...initialize, id: SWAP_REQUEST_ID })}\n`)
    })
  }
}

export const runProxy = (options: ProxyOptions): ProxyRun => new ProxyRun(options)
