import { join } from "node:path"
import { arkivPublicClient, arkivWalletClient, ArkivWriter, type Hex, type LoadedFile, readLatestLoadout, type Timers, type TrustPolicy } from "@ceasenet/core"
import { privateKeyToAccount } from "viem/accounts"
import { ArkivGuardNet, ReadOnlyNet } from "./arkivNet"
import { fileStore } from "./fileStore"
import { type Approver, Guard, type GuardEvent, type GuardNet } from "./guard"
import { type ProxyRun, runProxy } from "./proxyCore"

export interface GuardedOptions {
  file: LoadedFile
  command: string
  args: string[]
  /** Whose public trust list decides. */
  owner?: string
  /** Used until the owner has published a list. */
  policy: TrustPolicy
  /** With a key it publishes what it loaded, a heartbeat and its receipts. Without one it only reads the list. */
  agentKey?: Hex
  accessKey: string
  timers: Timers
  memoryDir: string
  /** Overrides the usual place this tool's memory is kept. */
  memoryFile?: string
  approve?: Approver
  onEvent?: (event: GuardEvent) => void
  log: (line: string) => void
}

/** Settings a tool's own process must never see, including anything this project's .env may have loaded. */
const HIDDEN_FROM_TOOL = /^(CEASENET_|ARKIV_|WORLD_|MODEL_|ZG_|SWARM_|BEE_|DEMO_MNEMONIC$)/

/** What a tool gets to see. Its own settings, such as a token its maker asks for, still reach it. */
export const toolEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !HIDDEN_FROM_TOOL.test(name)))

/** Starts the gate and the tool behind it, on this process's stdin and stdout. */
export async function runGuarded(options: GuardedOptions): Promise<{ guard: Guard; proxy: ProxyRun }> {
  const { file, owner, timers, log } = options
  const client = arkivPublicClient(options.accessKey)
  let net: GuardNet = new ReadOnlyNet(client, owner)
  let startSeq = 1n
  if (options.agentKey) {
    const writer = new ArkivWriter(arkivWalletClient(privateKeyToAccount(options.agentKey), options.accessKey))
    net = new ArkivGuardNet(client, owner, writer, timers.heartbeatTtlSeconds)
    startSeq = ((await readLatestLoadout(client, writer.address))?.seq ?? 0n) + 1n
  }
  const store = fileStore(options.memoryFile ?? join(options.memoryDir, `gate-${file.name.replace(/[^\w.-]/g, "_")}.json`))
  const guard = new Guard({ policy: options.policy, timers, store, files: [file], net, startSeq, approve: options.approve, onEvent: options.onEvent })
  await guard.start()
  guard.run()

  const proxy = runProxy({ guard, file, command: options.command, args: options.args, env: toolEnv(process.env), input: process.stdin, output: process.stdout, log })
  proxy.on("exit", (code: number | null) => process.exit(code ?? 1))
  proxy.on("error", (e: Error) => {
    log(`could not start the tool: ${e.message}`)
    process.exit(1)
  })
  return { guard, proxy }
}
