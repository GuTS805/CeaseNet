#!/usr/bin/env node
import { homedir } from "node:os"
import { join } from "node:path"
import { DEMO_TIMERS, demoPolicy, type Hex, PRODUCTION_TIMERS } from "@ceasenet/core"
import { agentPassFromEnv, approverFromPass, fileLinks } from "./agentPass"
import { measurePackage } from "./measure"
import { runGuarded } from "./runGuarded"

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
  const file = measurePackage(pkg)
  const log = (line: string) => console.error(`ceasenet-guard: ${line}`)
  const pass = agentPassFromEnv()
  const approve = pass && approverFromPass(pass, fileLinks(join(homedir(), ".ceasenet", "approvers.json")), owner ?? "this-machine", log)
  await runGuarded({
    file,
    command,
    args,
    owner,
    policy: demoPolicy(),
    agentKey: process.env.CEASENET_AGENT_KEY as Hex | undefined,
    accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
    timers: demoTimers ? DEMO_TIMERS : PRODUCTION_TIMERS,
    memoryDir: join(homedir(), ".ceasenet"),
    memoryFile: memory,
    approve,
    log,
  })
  log(`guarding ${file.name} ${file.version} (${file.hash})`)
}

await main().catch((e) => {
  console.error(`ceasenet-guard: ${(e as Error).message}`)
  process.exit(1)
})
