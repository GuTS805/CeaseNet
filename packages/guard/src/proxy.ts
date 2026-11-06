#!/usr/bin/env node
import { homedir } from "node:os"
import { join } from "node:path"
import { arkivPublicClient, arkivWalletClient, ArkivWriter, DEMO_TIMERS, demoPolicy, type Hex, PRODUCTION_TIMERS, readLatestLoadout } from "@ceasenet/core"
import { privateKeyToAccount } from "viem/accounts"
import { agentPassFromEnv, approverFromPass, fileLinks } from "./agentPass"
import { ArkivGuardNet, ReadOnlyNet } from "./arkivNet"
import { fileStore } from "./fileStore"
import { Guard, type GuardNet } from "./guard"
import { measurePackage } from "./measure"
import { runProxy } from "./proxyCore"

/**
 * Puts the gate in front of any MCP server that runs over stdio, with no change to the agent or the tool:
 *
 *   ceasenet-guard --package ./node_modules/some-tool --owner 0x... -- node ./node_modules/some-tool/server.js
 *
 * Everything passes through untouched except `tools/call`, which goes to the tool only if the gate allows it.
 *
 * With CEASENET_AGENT_KEY set it also publishes what it loaded, a heartbeat and its receipts. Without it, it
 * only reads the list, so it protects the agent and leaves no public trace.
 *
 * With WORLD_IDP_CLIENT_ID and WORLD_IDP_CLIENT_SECRET set, a call that needs a human waits for a real person to
 * approve it through World ID. Without them, such a call is refused.
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
  return {
    pkg,
    owner: value("--owner"),
    memory: value("--memory"),
    demoTimers: flags.includes("--demo-timers"),
    command: argv[split + 1]!,
    args: argv.slice(split + 2),
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { pkg, owner, memory, demoTimers, command, args } = parseArgs(argv)
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

  const store = fileStore(memory ?? join(homedir(), ".ceasenet", `gate-${file.name.replace(/[^\w.-]/g, "_")}.json`))
  const pass = agentPassFromEnv()
  const approve =
    pass && approverFromPass(pass, fileLinks(join(homedir(), ".ceasenet", "approvers.json")), owner ?? "this-machine", (line) => console.error(`ceasenet-guard: ${line}`))
  const guard = new Guard({ policy: demoPolicy(), timers, store, files: [file], net, startSeq, approve })
  await guard.start()
  guard.run()

  // The tool does not get the agent's key.
  const env = { ...process.env }
  delete env.CEASENET_AGENT_KEY
  delete env.WORLD_IDP_CLIENT_SECRET
  const proxy = runProxy({
    guard,
    file,
    command,
    args,
    env,
    input: process.stdin,
    output: process.stdout,
    log: (line) => console.error(`ceasenet-guard: ${line}`),
  })
  proxy.on("exit", (code: number | null) => process.exit(code ?? 1))
  proxy.on("error", (e: Error) => {
    console.error(`ceasenet-guard: could not start the tool: ${e.message}`)
    process.exit(1)
  })
  console.error(`ceasenet-guard: guarding ${file.name} ${file.version} (${file.hash})`)
}

await main().catch((e) => {
  console.error(`ceasenet-guard: ${(e as Error).message}`)
  process.exit(1)
})
