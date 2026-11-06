import { spawn } from "node:child_process"
import { runAgent } from "./agentRun"
import { memberView, type StartResult, startReport, TEAM } from "./fleet"
import { importSettings } from "./settings"
import { existsSync, statSync } from "node:fs"
import { hostname } from "node:os"
import { agentArtifact, fleetArtifact, type Hex, type LoadedFile, recallCovers } from "@ceasenet/core"
import { measurePackage } from "@ceasenet/guard"
import { currentPolicy, enrollAgent, isEnded, liftRecall, publishFix, publishIdentity, setFollowing, stopAgent, stopFleet, stopTool } from "./actions"
import { liveGuards, recentCalls } from "./activity"
import { startDaemon } from "./daemon"
import { daemonAlive, daemonBuild, readDaemonInfo, runningBuild, selfCommand, startDaemonIfNeeded, waitForDaemon } from "./daemonClient"
import { configExists, type Config, homeDir, initHome, loadConfig, loadKeys, saveConfig, setHold } from "./home"
import { formatBalance, ledgerFor } from "./ledger"
import { runHook } from "./hook"
import { addStopHook, claudeCodePresent, claudeSettingsPath, type ClientFile, hasStopHook, inspectAll, knownClientFiles, protectFile, removeStopHook, unprotectFile } from "./protect"
import { clearPin, resolvePlan } from "./resolve"
import { recalledByName, runGuard } from "./run"

const FAUCET = "https://hub.arkiv.network/faucet"
const ACCESS_KEYS = "https://hub.arkiv.network/access-keys"

// The SDK warns about this on every run. `ceasenet status` says it once, with what to do about it.
const warn = console.warn
console.warn = (...args: unknown[]) => {
  if (!String(args[0]).startsWith("Rabdi: no access key")) warn(...args)
}

const HELP = `CeaseNet: stop AI agents, and recall the tools they use.

Set up
  ceasenet init [--name <agent>] [--local] [--owner <0x...>] [--access-key <key>]
                                  Create this agent's identity. --local works with no wallet, on this machine only.
                                  --owner follows an owner whose key is on another machine.
  ceasenet protect [--config <file>] [--dry-run]
                                  Put the gate in front of every MCP server your agents use.
  ceasenet unprotect [--config <file>]
                                  Take it away again.
  ceasenet console [--no-open]    Open the console, to watch and stop your agents.
  ceasenet status                 What is protected, what is not, and what is running.
  ceasenet access-key <key>       Use your own Arkiv access key. It has a quota, and when that runs out reads carry on through the public endpoint.
  ceasenet import-settings <file> Copy the settings CeaseNet uses from a .env file. A wallet's secret phrase is left behind.
  ceasenet network <arkiv|local>  Keep recalls on the public list, or in a file on this machine.

See it work
  ceasenet agents start           Start three real AI trading agents, each in a terminal of its own, on live prices
                                  with paper money. They close themselves when a recall covers them.
  ceasenet agents status          Where each of them stands.
  ceasenet agents shutdown        End them, with no recall.

Stop things
  ceasenet kill --reason <why> [--agent <0x...>] [--all]
                                  Stop an agent, every tool at once. --all stops every agent you own.
  ceasenet stop <tool>[@<range>] --reason <why> [--severity <level>] [--advice <what to do>]
                                  Recall a tool by name. A range looks like ">=1.0.16 <1.0.17".
  ceasenet stop --hash <0x...> --reason <why>
                                  Recall one exact file.
  ceasenet lift <recall-key> [--note <why>]
                                  End a recall, or restart a stopped agent. What was stopped carries on.
  ceasenet fix <recall-key> --hash <0x...> --version <v> [--note <why>]
                                  Publish the file agents should move to.
  ceasenet hold <tool> | ceasenet release <tool>
                                  Ask a person before each call to this tool, or stop asking.

Whom you obey
  ceasenet enroll <0x...> --name <name>
                                  Add an agent running on another machine to the ones you own.

Look things up
  ceasenet recalls                Recalls your agents obey: yours.
  ceasenet check <tool>@<version> Is this version recalled by you?
  ceasenet check <folder>         The same for a package on disk, and prints its exact hash, which a recall names.
  ceasenet activity [-n <count>]  The latest calls your agents made, and what was decided.
  ceasenet update <spec>          Forget the pinned version of a tool, so its next start looks for a new one.

Used by your agent's client, not by you
  ceasenet run --name <server> [--package <dir>] -- <command> [args...]
  ceasenet hook                   Asked by Claude Code before each of its own tools runs.
`

interface Parsed {
  positional: string[]
  flags: Map<string, string | true>
}

/** Flags that take no value. Everything else that starts with -- takes the next word. */
const SWITCHES = new Set(["--local", "--dry-run", "--no-open", "--all", "--stay", "--wait-port", "--help"])

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      if (SWITCHES.has(a)) flags.set(a, true)
      else flags.set(a, argv[++i] ?? true)
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

const text = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name)
  return typeof v === "string" ? v : undefined
}

const out = (line = "") => console.log(line)

function needReason(p: Parsed): string {
  const reason = text(p, "--reason")
  if (!reason) throw new Error("Give a --reason. It is what the agent is told and what everyone else will read.")
  return reason
}

function networkLine(config: Config): string {
  return config.network === "local" ? "this machine only (local mode: nothing is public, and only agents here can obey)" : "the public list on Arkiv (Rabdi testnet)"
}

async function cmdInit(p: Parsed): Promise<void> {
  const owner = text(p, "--owner") as Hex | undefined
  if (owner && !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error(`${owner} is not an address.`)
  const { config, created } = initHome({
    name: text(p, "--name") ?? `${hostname()} agent`,
    network: p.flags.has("--local") ? "local" : "arkiv",
    accessKey: text(p, "--access-key") ?? process.env.ARKIV_ACCESS_KEY ?? "",
    owner,
    ledgerFile: text(p, "--ledger"),
    port: text(p, "--port") ? Number(text(p, "--port")) : undefined,
  })
  out(created ? "CeaseNet is set up." : `CeaseNet was already set up in ${homeDir()}. Nothing was changed.`)
  out()
  out(`  Agent    ${config.agent.name}  ${config.agent.address}`)
  out(`  Owner    ${config.owner.address}${created && owner ? "  (key held elsewhere)" : ""}`)
  out(`  Recalls  ${networkLine(config)}`)
  out(`  Keys     ${homeDir()}`)
  out()
  if (!created && owner && owner.toLowerCase() !== config.owner.address.toLowerCase()) {
    out(`This agent already answers to ${config.owner.address}, so --owner was not used. For another agent that answers to`)
    out(`${owner}, give it a folder of its own first. In PowerShell:  $env:CEASENET_HOME = "$HOME\\.ceasenet-2"`)
    out(`In a POSIX shell:  export CEASENET_HOME=~/.ceasenet-2`)
    out()
  }
  if (config.network === "arkiv" && !owner) {
    out("Stopping things on the public list costs a little test money. Fund the owner's address once:")
    out(`  ${config.owner.address}`)
    out(`  ${FAUCET}`)
    out("Your agents are protected and obey recalls without this. It is only needed to issue your own.")
    out()
  }
  out("Next:")
  out("  ceasenet protect    put the gate in front of your agents' MCP servers")
  out("  ceasenet console    watch them, and stop them")
}

const configFiles = (p: Parsed): ClientFile[] => {
  const path = text(p, "--config")
  return path ? [{ client: "Your file", path }] : knownClientFiles()
}

async function cmdProtect(p: Parsed): Promise<void> {
  const config = loadConfig()
  const files = configFiles(p).filter((f) => existsSync(f.path))
  const hookPath = text(p, "--hook-settings") ?? (!text(p, "--config") && claudeCodePresent() ? claudeSettingsPath() : undefined)
  if (files.length === 0 && !hookPath) {
    out("No MCP settings were found for any client we know of.")
    out("Point at yours with --config, or start a server by hand: ceasenet run --name <name> -- <command>")
    return
  }
  if (p.flags.has("--dry-run")) {
    for (const report of inspectAll(files)) {
      out(`${report.client}: ${report.path}`)
      if (report.problem) out(`  ${report.problem}`)
      if (report.servers.length === 0 && !report.problem) out("  no MCP servers")
      for (const s of report.servers) {
        const where = s.scope ? ` (${s.scope})` : ""
        out(`  ${s.state === "unprotected" ? "would protect" : s.state === "remote" ? "CANNOT protect, it is remote" : "already protected"}: ${s.name}${where}`)
      }
    }
    if (!text(p, "--config") && claudeCodePresent()) {
      out(`Claude Code's own tools (Bash, file edits): ${hasStopHook() ? "already covered" : `would add a hook to ${claudeSettingsPath()}`}`)
    }
    out()
    out("Nothing was changed.")
    return
  }
  const self = selfCommand()
  let total = 0
  const toPin: { name: string; command: string; args: string[] }[] = []
  for (const report of inspectAll(files)) {
    for (const s of report.servers) {
      if (s.state === "unprotected") toPin.push({ name: s.name, command: s.entry.command!, args: s.entry.args ?? [] })
    }
    const result = protectFile(report.path, self)
    out(`${report.client}: ${report.path}`)
    if (result.problem) out(`  ${result.problem}`)
    for (const name of result.changed) out(`  protected ${name}`)
    for (const name of result.remote) out(`  NOT protected: ${name} is a remote server, and the gate only sits in front of servers started on this machine`)
    if (result.backup) out(`  a copy of the old file is at ${result.backup}`)
    if (!result.problem && result.changed.length === 0 && result.remote.length === 0) out("  nothing to do")
    total += result.changed.length
  }
  // Done now rather than at first start, when a slow download could make the client give up on the server.
  for (const server of toPin) {
    try {
      const plan = await resolvePlan(server.command, server.args, { beforeInstall: (file) => recalledByName(config, file) })
      out(`  ${server.name}: ${plan.file.name} ${plan.file.version}, ${plan.strength === "command" ? "known by its command only" : `measured ${plan.file.hash.slice(0, 14)}…`}`)
    } catch (e) {
      out(`  ${server.name}: not looked up yet (${(e as Error).message}). It will be when it starts.`)
    }
  }
  if (hookPath) {
    const hook = addStopHook(self, hookPath)
    out(`Claude Code's own tools: ${hookPath}`)
    if (hook.problem) out(`  ${hook.problem}`)
    else if (hook.changed.length === 0) out("  already covered")
    else {
      total += 1
      out("  stopping this agent now also stops Bash, file edits and its other built-in tools")
      if (hook.backup) out(`  a copy of the old file is at ${hook.backup}`)
    }
  }
  out()
  out(total > 0 ? "Restart your agent's client so it picks this up. Then: ceasenet console" : "Nothing changed.")
}

function cmdUnprotect(p: Parsed): void {
  for (const f of configFiles(p).filter((file) => existsSync(file.path))) {
    const result = unprotectFile(f.path)
    out(`${f.client}: ${f.path}`)
    if (result.problem) out(`  ${result.problem}`)
    for (const name of result.changed) out(`  removed the gate from ${name}`)
    if (!result.problem && result.changed.length === 0) out("  nothing to do")
  }
  const hookPath = text(p, "--hook-settings") ?? (!text(p, "--config") ? claudeSettingsPath() : undefined)
  if (hookPath) {
    const hook = removeStopHook(hookPath)
    if (hook.problem) out(`Claude Code's own tools: ${hook.problem}`)
    if (hook.changed.length > 0) out(`Claude Code's own tools: removed the hook from ${hookPath}`)
  }
  out("Restart your agent's client so it picks this up.")
}

async function cmdStatus(): Promise<void> {
  if (!configExists()) {
    out("CeaseNet is not set up here. Run: ceasenet init")
    return
  }
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const keys = loadKeys()
  out(`Agent    ${config.agent.name}  ${config.agent.address}`)
  out(`Owner    ${config.owner.address}${keys.owner ? "" : "  (key held elsewhere)"}`)
  out(`Recalls  ${networkLine(config)}`)
  if (config.network === "arkiv" && !config.accessKey) {
    out(`Access   none, so reads use Arkiv's public endpoint, which has a rate limit. Get a free key at ${ACCESS_KEYS}, then: ceasenet access-key <key>`)
  }
  try {
    const [mine, its] = await Promise.all([ledger.balance(config.owner.address), ledger.balance(config.agent.address)])
    if (mine !== undefined) out(`Funds    owner ${formatBalance(mine)} tGLM, agent ${formatBalance(its ?? 0n)} tGLM${mine === 0n && keys.owner ? `. Claim at ${FAUCET}` : ""}`)
    const policy = await currentPolicy(ledger, config)
    out(`Obeys    ${policy.issuers.join(", ")}${(await ledger.publishedPolicy(config.owner.address)) ? "" : "  (not published yet)"}`)
    const { block } = await ledger.recalls([config.owner.address])
    out(`List     readable, block ${block}`)
  } catch (e) {
    out(`List     CANNOT BE READ: ${(e as Error).message.split("\n")[0]}`)
  }
  out(`Console  ${(await daemonAlive()) ? `http://127.0.0.1:${readDaemonInfo()!.port}` : "not running"}`)
  out()
  const guards = liveGuards()
  out(guards.length === 0 ? "No guards are running. They start when your agent's client starts its servers." : "Running now:")
  for (const g of guards) {
    const state = g.recall ? `STOPPED: ${g.recall.reason}` : g.blockedLocally ? `BLOCKED: ${g.blockedLocally}` : g.mode === "NEEDS_APPROVAL" ? "asks a person first" : g.mode === "BLOCK" ? "refusing" : "allowed"
    out(`  ${g.server}: ${g.file.name} ${g.file.version}  ${state}  ${g.toolPid ? `process ${g.toolPid}` : "not running"}`)
  }
  out()
  const reports = inspectAll(knownClientFiles())
  if (claudeCodePresent()) out(`Claude Code's own tools (Bash, file edits): ${hasStopHook() ? "covered, stopping this agent stops them too" : "NOT COVERED. Run: ceasenet protect"}`)
  for (const report of reports) {
    const count = (state: string) => report.servers.filter((s) => s.state === state).map((s) => s.name)
    const unprotected = count("unprotected")
    const remote = count("remote")
    out(`${report.client}: ${count("protected").length} protected${unprotected.length ? `, UNPROTECTED: ${unprotected.join(", ")}` : ""}${remote.length ? `, remote and not covered: ${remote.join(", ")}` : ""}${report.problem ? `. ${report.problem}` : ""}`)
  }
  if (reports.length === 0) out("No MCP settings were found for any client we know of.")
}

async function cmdConsole(p: Parsed, stay: boolean, open: boolean): Promise<void> {
  loadConfig()
  let waitForPort = p.flags.has("--wait-port")
  if (await daemonAlive()) {
    const info = readDaemonInfo()!
    if ((await runningBuild(info)) === daemonBuild()) {
      const url = `http://127.0.0.1:${info.port}`
      out(`The console is at ${url}`)
      if (open) openBrowser(url)
      return
    }
    // The one running is from before this program was updated, and its pages have gone.
    try {
      process.kill(info.pid)
    } catch {
      // It has already gone.
    }
    waitForPort = true
  }
  const handle = await startDaemon({ stay, waitForPort, port: text(p, "--port") ? Number(text(p, "--port")) : undefined })
  const url = `http://127.0.0.1:${handle.port}`
  out(`The console is at ${url}`)
  if (open) openBrowser(url)
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]
  spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined).unref()
}

async function cmdStop(p: Parsed): Promise<void> {
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const target = p.positional[0]
  const hash = text(p, "--hash")
  const at = target ? target.lastIndexOf("@") : -1
  const name = target && at > 0 ? target.slice(0, at) : target
  const versions = target && at > 0 ? target.slice(at + 1) : undefined
  const { entityKey } = await stopTool(ledger, config, {
    hash,
    name,
    versions,
    reason: needReason(p),
    severity: text(p, "--severity"),
    advice: text(p, "--advice"),
  })
  out(`STOP issued: ${entityKey}`)
  out(`Agents obeying you refuse ${name ?? hash} from their next check, and any process running it is ended.`)
  out(`To end it: ceasenet lift ${entityKey}`)
}

async function cmdKill(p: Parsed): Promise<void> {
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const reason = needReason(p)
  const { entityKey } = p.flags.has("--all") ? await stopFleet(ledger, config, reason) : await stopAgent(ledger, config, text(p, "--agent") ?? config.agent.address, reason)
  out(`STOP issued: ${entityKey}`)
  out(p.flags.has("--all") ? "All your agents refuse every tool from their next check." : "That agent refuses every tool from its next check.")
  out(`To restart: ceasenet lift ${entityKey}`)
}

async function cmdLift(p: Parsed): Promise<void> {
  const config = loadConfig()
  const key = p.positional[0] as Hex | undefined
  if (!key) throw new Error("Say which recall: ceasenet lift <recall-key>. ceasenet recalls lists them.")
  await liftRecall(ledgerFor(config), config, key, text(p, "--note"))
  out("Lifted. What it stopped carries on from its next check.")
}

async function cmdFix(p: Parsed): Promise<void> {
  const config = loadConfig()
  const key = p.positional[0] as Hex | undefined
  const hash = text(p, "--hash")
  const version = text(p, "--version")
  if (!key || !hash || !version) throw new Error("Use: ceasenet fix <recall-key> --hash <0x...> --version <v>")
  await publishFix(ledgerFor(config), config, key, hash, version, text(p, "--note"))
  out(`Fix published. Agents still on the recalled file stay blocked until they move to ${version}.`)
}

async function cmdRecalls(): Promise<void> {
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const policy = await currentPolicy(ledger, config)
  const { rows, block } = await ledger.recalls(policy.issuers)
  const lifts = await ledger.lifts(rows.map((r) => r.key))
  out(`${rows.length} recall(s) from the ${policy.issuers.length} key(s) you follow, at block ${block}`)
  for (const r of rows.sort((a, b) => Number(b.createdAt - a.createdAt))) {
    const target =
      r.artifact === agentArtifact(config.agent.address)
        ? "this agent"
        : r.artifact === fleetArtifact(config.owner.address)
          ? "all your agents"
          : r.pkg
            ? `${r.pkg} ${r.versions ?? ""}`.trim()
            : r.artifact
    out()
    out(`${r.level}${isEnded(r, lifts, policy) ? " (ended)" : ""}  ${r.severity}  ${target}`)
    out(`  ${r.reason}`)
    out(`  key ${r.key}, issued by ${r.creator}`)
  }
}

async function cmdCheck(p: Parsed): Promise<void> {
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const target = p.positional[0]
  if (!target) throw new Error("Use: ceasenet check <tool>@<version>, or ceasenet check <folder>")
  let file: LoadedFile
  if (existsSync(target) && statSync(target).isDirectory()) {
    // What is on disk, measured the way the gate measures it, so a recall naming this hash covers exactly this.
    file = measurePackage(target)
    out(`${file.name} ${file.version}
  hash ${file.hash}`)
  } else {
    const at = target.lastIndexOf("@")
    if (at <= 0) throw new Error("Say which version: ceasenet check <tool>@<version>")
    file = { kind: "tool", name: target.slice(0, at), version: target.slice(at + 1), hash: text(p, "--hash") ?? "0x" }
  }
  const policy = await currentPolicy(ledger, config)
  const { rows } = await ledger.recalls(policy.issuers)
  const lifts = await ledger.lifts(rows.map((r) => r.key))
  const hits = rows.filter((r) => recallCovers(r, file) && !isEnded(r, lifts, policy))
  if (hits.length === 0) {
    out(`Nobody you follow has recalled ${file.name}@${file.version}. That does not prove it is safe.`)
    return
  }
  for (const r of hits) out(`${r.level === "STOP" ? "RECALLED" : "WARNING"}: ${r.reason}${r.advice ? `\n  What to do: ${r.advice}` : ""}\n  Issued by ${r.creator}`)
  process.exitCode = 2
}

function cmdActivity(p: Parsed): void {
  const calls = recentCalls(Number(text(p, "-n")) || 20)
  if (calls.length === 0) out("No calls yet.")
  for (const c of calls) {
    const what = c.allowed ? (c.approval === "APPROVED" ? "approved" : "allowed") : c.approval === "DENIED" ? "refused by a person" : c.approval === "EXPIRED" ? "nobody approved it" : "REFUSED"
    out(`${new Date(c.at).toLocaleTimeString()}  ${what.padEnd(20)} ${c.tool} ${c.action}${c.message ? `\n    ${c.message}` : ""}`)
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv
  // The guard's own arguments belong to the server it starts, so they are not read as ours.
  if (command === "run") return runGuard(rest)
  if (command === "hook") return runHook()
  if (command === "agent-run") return runAgent(rest)
  const p = parse(rest)
  if (!command || command === "help" || command === "--help" || command === "-h" || p.flags.has("--help")) {
    out(HELP)
    return
  }
  switch (command) {
    case "init":
      return cmdInit(p)
    case "protect":
      return cmdProtect(p)
    case "unprotect":
      return cmdUnprotect(p)
    case "status":
      return cmdStatus()
    case "console":
      return cmdConsole(p, true, !p.flags.has("--no-open"))
    case "daemon":
      return cmdConsole(p, p.flags.has("--stay"), false)
    case "stop":
      return cmdStop(p)
    case "kill":
      return cmdKill(p)
    case "lift":
      return cmdLift(p)
    case "fix":
      return cmdFix(p)
    case "hold":
    case "release": {
      const tool = p.positional[0]
      if (!tool) throw new Error(`Say which tool: ceasenet ${command} <tool>`)
      setHold(tool, command === "hold")
      out(command === "hold" ? `Each call to ${tool} now waits for a person, at the console.` : `Calls to ${tool} no longer wait for a person.`)
      return
    }
    case "follow":
    case "unfollow": {
      const address = p.positional[0]
      if (!address) throw new Error(`Say whose key: ceasenet ${command} <0x...>`)
      const config = loadConfig()
      const policy = await setFollowing(ledgerFor(config), config, address, command === "follow")
      out(`You now obey STOPs from: ${policy.issuers.join(", ")}`)
      return
    }
    case "enroll": {
      const agent = p.positional[0] as Hex | undefined
      if (!agent) throw new Error("Use: ceasenet enroll <0x...> --name <name>")
      const config = loadConfig()
      await enrollAgent(ledgerFor(config), config, agent, text(p, "--name") ?? "Agent")
      out(`${agent} is now one of your agents, and you can stop it from here.`)
      return
    }
    case "publish": {
      const config = loadConfig()
      const done = await publishIdentity(ledgerFor(config), config)
      out(done.length ? done.join("\n") : "Everything is already published.")
      return
    }
    case "import-settings": {
      const from = p.positional[0]
      if (!from) throw new Error("Say which file: ceasenet import-settings <path to .env>")
      const { imported, left } = importSettings(from)
      out(imported.length ? `Copied: ${imported.join(", ")}` : "Nothing in that file is a setting CeaseNet uses.")
      if (left.length) out(`Left behind on purpose: ${left.join(", ")}`)
      out("The console and the agents use these from their next start.")
      return
    }
    case "network": {
      const network = p.positional[0]
      if (network !== "arkiv" && network !== "local") throw new Error("Use: ceasenet network arkiv, or ceasenet network local")
      saveConfig({ ...loadConfig(), network })
      out(network === "arkiv" ? "Recalls now go on the public list on Arkiv." : "Recalls now stay in a file on this machine.")
      out("Start the console again, and restart your agent's client, so they follow.")
      return
    }
    case "agents": {
      const action = p.positional[0] ?? "status"
      const config = loadConfig()
      if (action === "status") {
        for (const m of TEAM) {
          const view = memberView(m)
          const phase = view.state?.phase ?? "not started"
          out(`${m.name.padEnd(16)} ${view.alive ? `${phase}, process ${view.state!.pid}` : phase === "closed" ? `closed: ${view.state!.closed?.reason}` : "not running"}  ${view.state?.jobs ?? 0} jobs`)
        }
        return
      }
      if (action !== "start" && action !== "shutdown") throw new Error("Use: ceasenet agents start, ceasenet agents status, or ceasenet agents shutdown")
      await startDaemonIfNeeded(config)
      const info = await waitForDaemon()
      const res = await fetch(`http://127.0.0.1:${info.port}/api/team/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-ceasenet-token": info.token }, body: "{}" })
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
      if (action === "shutdown") {
        out("They have been shut down, with no recall.")
        return
      }
      for (const line of startReport((await res.json()) as StartResult)) out(line)
      out(`The console is at http://127.0.0.1:${info.port}`)
      return
    }
    case "access-key": {
      const key = p.positional[0]
      if (!key) throw new Error(`Use: ceasenet access-key <key>. Get a free one at ${ACCESS_KEYS}`)
      saveConfig({ ...loadConfig(), accessKey: key })
      out("Saved. Guards and the console use it from their next start.")
      return
    }
    case "recalls":
      return cmdRecalls()
    case "check":
      return cmdCheck(p)
    case "activity":
      return cmdActivity(p)
    case "update": {
      const spec = p.positional[0]
      if (!spec) throw new Error("Use: ceasenet update <spec>, as it appears after npx in your settings")
      out(clearPin(spec) ? `Forgotten. ${spec} looks up its version again the next time your client starts it.` : `${spec} is not pinned.`)
      return
    }
    default:
      throw new Error(`There is no command "${command}". Try: ceasenet help`)
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`ceasenet: ${(e as Error).message}`)
  process.exit(1)
})
