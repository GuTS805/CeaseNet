import { type LoadedFile, PRODUCTION_TIMERS, recallCovers, type Timers, verdictFor } from "@ceasenet/core"
import { agentPassFromEnv, type Approver, approverFromPass, fileLinks, fileStore, type GatedProxy, Guard, runProxy } from "@ceasenet/guard"
import { type GuardStatus, recordCall, removeStatus, writeStatus } from "./activity"
import { approverFromDaemon, startDaemonIfNeeded } from "./daemonClient"
import { type Config, identityOf, inHome, loadConfig, loadHolds, nudgeTime, obeyingOwner, safeName, startingPolicy } from "./home"
import { recordFinishedCall } from "./journal"
import { ledgerFor } from "./ledger"
import { type LaunchPlan, RecalledBeforeInstall, resolvePlan } from "./resolve"

/** How often a guard looks for a request to read the list right away. Looking costs nothing. */
const NUDGE_POLL_MS = 500
/** How often a pinned tool's files are measured again. */
const REMEASURE_MS = 15_000

const log = (line: string) => console.error(`ceasenet: ${line}`)

/** A guard that is told by a test or a hurried owner can read the list as often as it likes. */
export function guardTimers(env = process.env): Timers {
  const every = Number(env.CEASENET_CHECK_MS)
  return every > 0 ? { ...PRODUCTION_TIMERS, checkIntervalMs: every } : PRODUCTION_TIMERS
}

interface RunArgs {
  server: string
  packageDir?: string
  command: string
  args: string[]
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const split = argv.indexOf("--")
  if (split === -1 || split === argv.length - 1) throw new Error("Give the server's command after --, for example: ceasenet run --name files -- npx -y some-server")
  // --ceasenet only marks a line in a client's settings as ours. It means nothing here.
  const flags = argv.slice(0, split).filter((a) => a !== "--ceasenet")
  const value = (name: string) => {
    const i = flags.indexOf(name)
    return i === -1 ? undefined : flags[i + 1]
  }
  const command = argv[split + 1]!
  const args = argv.slice(split + 2)
  return { server: value("--name") ?? command, packageDir: value("--package"), command, args }
}

/** Whether a recall the owner follows names this package and version, before there is anything to measure. */
export async function recalledByName(config: Config, file: LoadedFile): Promise<string | undefined> {
  try {
    const view = await ledgerFor(config).readOnlyNet().readView(obeyingOwner(startingPolicy(config.owner.address), config.owner.address), [])
    const hit = view.stops.find((s) => recallCovers(s, file) && !view.lifts.some((l) => l.recall === s.key && l.kind === "WITHDRAWN" && l.creator.toLowerCase() === s.creator.toLowerCase()))
    return hit?.reason
  } catch {
    // The list cannot be read. The gate's own rules for that apply once the tool is known.
    return undefined
  }
}

/**
 * Stands in for an MCP server: the agent's client starts this in place of the server, and this starts the server.
 * Everything it decides comes from the list and from what it measured. It holds no keys.
 */
export async function runGuard(argv: readonly string[]): Promise<void> {
  const { server, packageDir, command, args } = parseRunArgs(argv)
  const config = loadConfig()
  const owner = config.owner.address
  const ledger = ledgerFor(config)
  const timers = guardTimers()

  let plan: LaunchPlan
  let neverInstalled = false
  try {
    plan = await resolvePlan(command, args, { packageDir, beforeInstall: (file) => recalledByName(config, file) })
  } catch (e) {
    if (!(e instanceof RecalledBeforeInstall)) throw e
    log(e.message)
    // Nothing to start, but the agent still needs to hear why from something that speaks its protocol.
    neverInstalled = true
    plan = { file: e.file, command: process.execPath, args: [], strength: "pinned" }
  }
  const file = plan.file

  const pass = agentPassFromEnv()
  const approve: Approver = pass
    ? approverFromPass(pass, fileLinks(inHome("approvers.json")), owner, (line) => log(line))
    : approverFromDaemon(server)

  const guard = new Guard({
    policy: startingPolicy(owner),
    timers,
    store: fileStore(inHome("gates", `${safeName(server)}.json`)),
    files: [file, ...identityOf(config)],
    net: ledger.readOnlyNet(),
    startSeq: 1n,
    approve,
  })
  await guard.start()
  const stopTimers = guard.run()

  // A pinned package should stay as it was installed. If it does not, it is no longer what was measured.
  let tampered: string | undefined
  let lastMeasured = Date.now()
  const measureAgain = () => {
    if (!plan.integrity || tampered || Date.now() - lastMeasured < REMEASURE_MS) return
    lastMeasured = Date.now()
    try {
      const problem = plan.integrity()
      if (problem) tampered = `${file.name} ${file.version} changed after it was installed: ${problem}`
    } catch {
      tampered = `the files of ${file.name} ${file.version} can no longer be read`
    }
  }

  const status: GuardStatus = {
    pid: process.pid,
    server,
    file,
    strength: plan.strength,
    online: true,
    mode: "ALLOW",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  let lastNudge = nudgeTime()
  /** Something on this machine changed the list, so the last reading is out of date. */
  const readIfNudged = (): Promise<void> | undefined => {
    const now = nudgeTime()
    if (now === lastNudge) return undefined
    lastNudge = now
    return guard.check(true)
  }

  // Set once the proxy exists. It reports its first state while it is still being created.
  let proxy: GatedProxy | undefined
  const publish = (toolPid: number | undefined = proxy?.pid) => {
    const recall = guard.stopOn(file)
    const last = guard.lastCheck
    status.updatedAt = Date.now()
    status.online = last?.online ?? false
    status.mode = tampered || neverInstalled ? "BLOCK" : last ? verdictFor(last.decision, file.hash) : "BLOCK"
    status.toolPid = toolPid
    status.blockedLocally = tampered
    status.recall = recall && { key: recall.key, reason: recall.reason, issuer: recall.creator, artifact: recall.artifact }
    writeStatus(status)
  }

  // A tool's secrets come through its environment, and those stay. CeaseNet's own settings do not.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CEASENET_") && k !== "WORLD_IDP_CLIENT_SECRET"))

  proxy = runProxy({
    guard,
    file,
    command: plan.command,
    args: plan.args,
    env,
    input: process.stdin,
    output: process.stdout,
    log,
    holdReason: () => (loadHolds().includes(file.name) ? `You asked to approve each call to ${file.name}.` : undefined),
    localBlock: () => {
      if (neverInstalled) return "it was recalled when this agent started, so it was never installed. Restart the agent to load it again"
      measureAgain()
      return tampered
    },
    onCall: ({ action, decision, gateMs }) => {
      recordCall({
        at: Date.now(),
        server,
        tool: file.name,
        version: file.version,
        action,
        allowed: decision.allowed,
        verdict: decision.verdict,
        approval: decision.approval,
        message: decision.allowed ? "" : decision.message,
        gateMs,
      })
    },
    // Before anything else here, so a call is on record whatever happens next. Nothing leaves this machine from a guard.
    onFinished: (call) => {
      try {
        recordFinishedCall(call, { server, name: file.name, version: file.version, hash: file.hash })
      } catch (e) {
        log(`could not write this call down: ${(e as Error).message}`)
      }
    },
    onState: (state) => publish(state.pid),
    // Polling alone leaves a moment after pressing Stop when a call could still use the last reading.
    freshen: () => (readIfNudged() ?? Promise.resolve()),
  })
  const running = proxy
  guard.onChecked(() => publish())
  publish()

  const nudges = setInterval(() => void readIfNudged(), NUDGE_POLL_MS)

  const leave = (code: number) => {
    stopTimers()
    clearInterval(nudges)
    removeStatus(status)
    process.exit(code)
  }
  running.on("exit", (code: number | null) => leave(code ?? 0))
  // The agent's client has gone, so nothing is left to protect, and the tool must not outlive it.
  process.stdout.on("error", () => {
    running.kill()
    leave(0)
  })
  running.on("error", (e: Error) => {
    log(`could not start ${server}: ${e.message}`)
    leave(1)
  })
  // Whoever ends the guard also ends the tool. It must not be left running with nothing in front of it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      running.kill()
      leave(0)
    })
  }

  log(`guarding ${server}: ${file.name} ${file.version} (${plan.strength}, ${file.hash})`)
  // The console is a convenience, and nothing here waits for it or depends on it.
  startDaemonIfNeeded(config).catch(() => undefined)
}
