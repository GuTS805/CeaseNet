import { type ChildProcess, spawn } from "node:child_process"
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

/**
 * Sits between an agent and an MCP server that runs over stdio.
 *
 * Everything passes through untouched except `tools/call`, which goes to the tool only if the gate allows it.
 * A refused call is answered as a tool error, not a protocol error, so the agent's model reads the reason and
 * can change course.
 */
export function runProxy(options: ProxyOptions): ChildProcess {
  const { guard, file, input, output } = options
  const log = options.log ?? (() => undefined)
  // stdout carries the protocol, so the tool's own messages go to stderr.
  const child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "inherit"], env: options.env })

  createInterface({ input: child.stdout! }).on("line", (line) => void output.write(`${line}\n`))

  // Requests are handled in order, so a call waiting on the gate cannot be overtaken by the one after it.
  let queue: Promise<void> = Promise.resolve()
  const forward = (line: string) => child.stdin!.write(`${line}\n`)

  createInterface({ input }).on("line", (line) => {
    queue = queue
      .then(async () => {
        let message: { id?: unknown; method?: string; params?: { name?: unknown } }
        try {
          message = JSON.parse(line)
        } catch {
          forward(line)
          return
        }
        if (message?.method !== "tools/call") {
          forward(line)
          return
        }
        const action = String(message.params?.name ?? "unknown")
        const decision = await guard.beforeCall(file, action)
        if (decision.allowed) {
          forward(line)
          return
        }
        log(`refused ${action}: ${decision.message}`)
        output.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { isError: true, content: [{ type: "text", text: decision.message }] },
          })}\n`,
        )
      })
      .catch((e) => log(`could not handle a request: ${(e as Error).message}`))
  })
  input.on("end", () => child.stdin!.end())
  return child
}
