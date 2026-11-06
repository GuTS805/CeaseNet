#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { arkivPublicClient, arkivWalletClient, ArkivWriter, DEMO_TIMERS, demoPolicy, type Hex, memoryStore, PRODUCTION_TIMERS, readLatestLoadout } from "@ceasenet/core"
import { privateKeyToAccount } from "viem/accounts"
import { ArkivGuardNet, ReadOnlyNet } from "./arkivNet"
import { Guard, type GuardNet } from "./guard"
import { measurePackage } from "./measure"

/**
 * Puts the gate in front of any MCP server that runs over stdio, with no change to the agent or the tool:
 *
 *   ceasenet-guard --package ./node_modules/some-tool --owner 0x... -- node ./node_modules/some-tool/server.js
 *
 * Everything passes through untouched except `tools/call`, which goes to the tool only if the gate allows it.
 *
 * With CEASENET_AGENT_KEY set it also publishes what it loaded, a heartbeat and its receipts. Without it, it
 * only reads the list, so it protects the agent and leaves no public trace.
 */
function parseArgs(argv: string[]) {
  const split = argv.indexOf("--")
  if (split === -1 || split === argv.length - 1) throw new Error("Give the tool's command after --")
  const flags = argv.slice(0, split)
  const value = (name: string) => {
    const i = flags.indexOf(name)
    return i === -1 ? undefined : flags[i + 1]
  }
  const pkg = value("--package")
  if (!pkg) throw new Error("--package must point at the installed tool, so it can be measured")
  return { pkg, owner: value("--owner"), demoTimers: flags.includes("--demo-timers"), command: argv[split + 1]!, args: argv.slice(split + 2) }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { pkg, owner, demoTimers, command, args } = parseArgs(argv)
  const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
  const timers = demoTimers ? DEMO_TIMERS : PRODUCTION_TIMERS
  const client = arkivPublicClient(accessKey)
  const file = measurePackage(pkg)

  let net: GuardNet = new ReadOnlyNet(client, owner)
  let startSeq = 1n
  const key = process.env.CEASENET_AGENT_KEY as Hex | undefined
  if (key) {
    const writer = new ArkivWriter(arkivWalletClient(privateKeyToAccount(key), accessKey))
    net = new ArkivGuardNet(client, owner, writer, timers.heartbeatTtlSeconds)
    startSeq = ((await readLatestLoadout(client, writer.address))?.seq ?? 0n) + 1n
  }

  const guard = new Guard({ policy: demoPolicy(), timers, store: memoryStore(), files: [file], net, startSeq })
  await guard.start()
  guard.run()

  // stdout carries the protocol, so anything else goes to stderr. The tool does not get the agent's key.
  const env = { ...process.env }
  delete env.CEASENET_AGENT_KEY
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env })
  child.on("exit", (code) => process.exit(code ?? 1))
  child.on("error", (e) => {
    console.error(`ceasenet-guard: could not start the tool: ${e.message}`)
    process.exit(1)
  })
  console.error(`ceasenet-guard: guarding ${file.name} ${file.version} (${file.hash})`)

  const toAgent = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
  createInterface({ input: child.stdout! }).on("line", (line) => void process.stdout.write(`${line}\n`))

  // Requests are handled in order, so a call waiting on the gate cannot be overtaken by the one after it.
  let queue: Promise<void> = Promise.resolve()
  createInterface({ input: process.stdin }).on("line", (line) => {
    queue = queue.then(async () => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        child.stdin!.write(`${line}\n`)
        return
      }
      if (message?.method !== "tools/call") {
        child.stdin!.write(`${line}\n`)
        return
      }
      const decision = await guard.beforeCall(file, String(message.params?.name ?? "unknown"))
      if (decision.allowed) {
        child.stdin!.write(`${line}\n`)
        return
      }
      console.error(`ceasenet-guard: refused ${message.params?.name}: ${decision.message}`)
      // A tool error rather than a protocol error, so the agent's model reads the reason and can change course.
      toAgent({
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: true, content: [{ type: "text", text: decision.message }] },
      })
    })
  })
  process.stdin.on("end", () => child.stdin!.end())
}

await main().catch((e) => {
  console.error(`ceasenet-guard: ${(e as Error).message}`)
  process.exit(1)
})
