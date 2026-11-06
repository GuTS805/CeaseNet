import { spawnSync, spawn as nodeSpawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type Hex, type LoadedFile } from "@ceasenet/core"
import { modelFromEnv, modelHost } from "@ceasenet/demo/brain"
import { measurePackage, writeAtomic } from "@ceasenet/guard"
import spawn from "cross-spawn"
import { type CallRecord, type GuardStatus, isAlive, liveGuards, recentCalls } from "./activity"
import { selfCommand } from "./daemonClient"
import { type Config, createMemberHome, inHome } from "./home"
import type { Settings } from "./settings"

/**
 * Three real AI trading agents, each in a real terminal of its own.
 *
 * Each is a process of its own with its own key. A real model decides each step, through real MCP servers, on live
 * market prices. The money is paper: orders fill at the live price in an account in the agent's own folder, and no
 * real funds exist to lose. Each keeps reading the recall list, and when a recall covers it, it closes itself and its
 * process ends.
 */

export type ToolId = "market" | "broker"

export interface ToolDefinition {
  id: ToolId
  /** The package's name. */
  spec: string
  /** The folder it ships in, under tools. */
  dir: string
  /** A person's name for it. */
  label: string
  /** The calls these agents' jobs use. Offering a model only these saves tokens on every request. */
  calls: string[]
}

export const TOOLS: Record<ToolId, ToolDefinition> = {
  market: { id: "market", spec: "trade-market-tool", dir: "trade-market-tool-1.0.0", label: "Market data", calls: ["get_price", "get_candles"] },
  broker: { id: "broker", spec: "trade-broker-tool", dir: "trade-broker-tool-1.0.0", label: "Paper broker", calls: ["get_portfolio", "place_order"] },
}

const here = dirname(fileURLToPath(import.meta.url))

/** Beside the installed program, or in this repository when run from source. */
export function toolDir(tool: ToolDefinition): string {
  const shipped = join(here, "tools", tool.dir)
  return existsSync(shipped) ? shipped : resolve(here, "..", "..", "..", "tools", tool.dir)
}

export interface Task {
  /** What this job is about. Here, a market. */
  file: string
  /** Written to the agent's inbox, for a job that reads a file. */
  content?: string
}

export interface Member {
  id: string
  name: string
  does: string
  tools: ToolId[]
  /** What the agent is, in the model's own instructions. */
  role: string
  tasks: Task[]
  /** The job, given the task and where its result goes. */
  job: (input: { task: string; result: string; n: number }) => string
}

export const SHARED_RULES =
  "Work only through your tools, one call at a time. Decide only from what the tools say: if they give no data, do not trade. All money here is paper. When you finish, reply with one short sentence saying what you did and why. If a tool is refused, stop at once and say so."

const MARKETS: Task[] = [{ file: "BTC-USD" }, { file: "ETH-USD" }, { file: "SOL-USD" }]

/** Every one of them reads the market, so recalling that closes all three. Only the two traders use the broker, so recalling it closes two. */
export const TEAM: Member[] = [
  {
    id: "momentum",
    name: "Momentum trader",
    does: "Buys what is rising and sells what is falling, with paper money",
    tools: ["market", "broker"],
    role: "You are a momentum trader with a paper account.",
    tasks: MARKETS,
    job: ({ task, n }) =>
      `Job ${n}, on ${task}. Call get_candles for ${task}, then get_portfolio. If it rose by more than 0.1% in the last hour, buy between 100 and 300 dollars of it. If it fell by more than 0.1% and you hold some, sell between 100 and 300 dollars of it. Otherwise do not trade.`,
  },
  {
    id: "reversion",
    name: "Reversion trader",
    does: "Buys dips and sells spikes, with paper money",
    tools: ["market", "broker"],
    role: "You are a mean-reversion trader with a paper account.",
    tasks: MARKETS,
    job: ({ task, n }) =>
      `Job ${n}, on ${task}. Call get_candles for ${task}, then get_portfolio. If it fell by more than 0.1% in the last hour, buy between 100 and 300 dollars of it. If it rose by more than 0.1% and you hold some, sell between 100 and 300 dollars of it. Otherwise do not trade.`,
  },
  {
    id: "risk",
    name: "Risk watcher",
    does: "Watches live markets and says what looks dangerous. It never trades",
    tools: ["market"],
    role: "You watch markets for a trading desk, and you never trade.",
    tasks: MARKETS,
    job: ({ task, n }) => `Job ${n}, on ${task}. Call get_price for ${task}, then get_candles for it. Say in one short sentence how much it moved in the last hour and whether that looks calm or dangerous.`,
  },
]

export const memberNamed = (id: string): Member => {
  const found = TEAM.find((m) => m.id === id)
  if (!found) throw new Error(`There is no agent called ${id}.`)
  return found
}

export const memberHome = (id: string): string => inHome("team", id)
export const workspaceOf = (home: string): string => join(home, "workspace")

const WATCHED = "team-watched"
/** Marks that someone is looking at the page, so agents know their work is worth spending on. */
export const markWatched = (): void => writeFileSync(inHome(WATCHED), String(Date.now()))

export const CLAUDE_MODEL = "haiku"

export type Thinking = { kind: "api"; model: string; host: string; requestsPerMinute: number } | { kind: "claude"; model: string; version?: string }

/** Set from the console. The word `claude`, or the name of a model on the key. */
export const THINKING_SETTING = "AGENT_THINKING"

/** The settings a model is reached with, once the choice made at the console is taken into account. */
export const modelSettings = (settings: Settings) => {
  const choice = settings[THINKING_SETTING]
  return modelFromEnv({ ...settings, ...(choice && choice !== "claude" ? { MODEL_NAME: choice } : {}) } as NodeJS.ProcessEnv)
}

/**
 * What the agents think with. A model key set up for the purpose comes first, since it spends nothing of anyone's
 * Claude plan. Without a model there is nothing to run: these agents never pretend to think.
 */
export function chooseThinking(settings: Settings): Thinking | undefined {
  const wantsClaude = settings[THINKING_SETTING] === "claude"
  if (settings.MODEL_API_KEY && !wantsClaude) {
    const model = modelSettings(settings)
    return { kind: "api", model: model.model, host: modelHost(model.url), requestsPerMinute: model.requestsPerMinute }
  }
  const claude = claudeAvailable()
  if (claude.ok) return { kind: "claude", model: CLAUDE_MODEL, version: claude.version }
  // Asked for Claude Code and it has gone, but there is still a key.
  if (settings.MODEL_API_KEY) {
    const model = modelSettings(settings)
    return { kind: "api", model: model.model, host: modelHost(model.url), requestsPerMinute: model.requestsPerMinute }
  }
  return undefined
}

/** Models a service lists that cannot hold a conversation at all. */
const NOT_FOR_CHAT = /guard|whisper|tts|orpheus|compound|embed/i

/** What this key can use, as far as the service says. */
export async function listModels(settings: Settings): Promise<string[]> {
  if (!settings.MODEL_API_KEY) return []
  const { url, apiKey } = modelSettings(settings)
  const res = await fetch(`${url.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8_000) })
  if (!res.ok) return []
  const { data } = (await res.json()) as { data: { id: string }[] }
  return data.map((m) => m.id).filter((id) => !NOT_FOR_CHAT.test(id)).sort()
}

export interface ModelTest {
  ok: boolean
  /** The limit it has reached, in plain words. */
  limited?: string
  problem?: string
  ms?: number
}

const TEST_TOOL = { type: "function", function: { name: "read_text_file", description: "Read a file as text.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }

/**
 * Asks a model for one real tool call, which is the only way to know.
 * A service's list of models does not say which can use tools, or which have used up their allowance for today.
 */
export async function testModel(settings: Settings, name: string): Promise<ModelTest> {
  const { url, apiKey } = modelSettings(settings)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: name, temperature: 0, max_tokens: 200, messages: [{ role: "user", content: "Read the file at /a.txt." }], tools: [TEST_TOOL] }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { tool_calls?: unknown[] } }[] }
    if (res.status === 429) {
      const perDay = /per day/i.test(body.error?.message ?? "")
      return { ok: false, limited: perDay ? `Today's allowance for ${name} is used up.` : `${name} has reached its limit for this minute.` }
    }
    if (!res.ok) return { ok: false, problem: `${name} cannot be used: ${(body.error?.message ?? `HTTP ${res.status}`).split("\n")[0]}` }
    if (!body.choices?.[0]?.message?.tool_calls?.length) return { ok: false, problem: `${name} answered, but did not use the tool it was offered, so it cannot do these agents' work.` }
    return { ok: true, ms: Date.now() - startedAt }
  } catch (e) {
    return { ok: false, problem: `${name} did not answer: ${(e as Error).message.split("\n")[0]}` }
  }
}

// ---- What each agent says about itself ----

export type AgentPhase = "starting" | "working" | "idle" | "paused" | "waiting" | "closing" | "closed" | "off"

export interface AgentState {
  id: string
  name: string
  pid: number
  phase: AgentPhase
  startedAt: number
  updatedAt: number
  address: string
  jobs: number
  job?: string
  lastSaid?: string
  checks: number
  lastCheck?: { at: number; block: string; online: boolean; tookMs: number; stopsRead: number }
  tools: LoadedFile[]
  closed?: { at: number; reason: string; recall?: string; artifact?: string; tool?: string; afterStart: boolean }
  problem?: string
}

export interface AgentEvent {
  at: number
  kind: "started" | "check" | "job" | "said" | "closed" | "problem" | "paused"
  text: string
}

export const writeAgentState = (home: string, state: AgentState): void => writeAtomic(join(home, "state.json"), JSON.stringify(state))

export function readAgentState(home: string): AgentState | undefined {
  try {
    return JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as AgentState
  } catch {
    return undefined
  }
}

export function readAgentEvents(home: string, limit = 60): AgentEvent[] {
  try {
    return readFileSync(join(home, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AgentEvent]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

// ---- Getting them ready ----

let claudeLookup: { at: number; result: { ok: boolean; version?: string; problem?: string } } | undefined
/** Starting a program to ask this takes a moment, and the page asks often. */
const CLAUDE_LOOKUP_MS = 5 * 60_000

/** Whether there is a model to think with, and what to say if not. */
export function claudeAvailable(): { ok: boolean; version?: string; problem?: string } {
  if (claudeLookup && Date.now() - claudeLookup.at < CLAUDE_LOOKUP_MS) return claudeLookup.result
  let result: { ok: boolean; version?: string; problem?: string } = { ok: false, problem: "Claude Code is not installed here. Install it and log in: https://claude.com/claude-code" }
  try {
    const res = spawn.sync("claude", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
    if (res.status === 0) result = { ok: true, version: String(res.stdout).trim() }
  } catch {
    // Reported as it stands.
  }
  claudeLookup = { at: Date.now(), result }
  return result
}

export const mcpSettingsPath = (home: string): string => join(home, "mcp.json")

/** The servers an agent may use. Each goes through the gate, and keeps its files in this agent's own folder. */
export function memberMcpSettings(member: Member, home: string, mainHome: string, self: { command: string; args: string[] }) {
  const workspace = workspaceOf(home)
  const env = { CEASENET_HOME: home, CEASENET_MAIN_HOME: mainHome, CEASENET_NO_DAEMON: "1" }
  const gated = (tool: ToolDefinition, toolArgs: string[] = []) => {
    const dir = toolDir(tool)
    return {
      command: self.command,
      args: [...self.args, "run", "--ceasenet", "--name", tool.id, "--package", dir, "--", self.command, join(dir, "server.mjs"), ...toolArgs],
      env,
    }
  }
  const servers: Record<string, unknown> = {}
  if (member.tools.includes("market")) servers.market = gated(TOOLS.market)
  if (member.tools.includes("broker")) servers.broker = gated(TOOLS.broker, ["--book", join(workspace, "book.json"), "--outbox", join(workspace, "outbox")])
  return { mcpServers: servers }
}

export interface PreparedTool extends ToolDefinition {
  file: LoadedFile
}

/** Measures each tool as it is on disk, which is what a recall names. */
export const prepareTools = (): PreparedTool[] => Object.values(TOOLS).map((tool) => ({ ...tool, file: measurePackage(toolDir(tool)) }))

export function prepareMember(member: Member, config: Config, self: { command: string; args: string[] }, mainHome: string): Config {
  const home = memberHome(member.id)
  const created = createMemberHome(home, member, config)
  for (const dir of ["inbox", "outbox"]) mkdirSync(join(workspaceOf(home), dir), { recursive: true })
  for (const task of member.tasks) {
    const path = join(workspaceOf(home), "inbox", task.file)
    if (task.content !== undefined && !existsSync(path)) writeFileSync(path, task.content)
  }
  writeAtomic(mcpSettingsPath(home), JSON.stringify(memberMcpSettings(member, home, mainHome, self), null, 2))
  return created
}

// ---- Starting and ending them ----

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * Opens a real terminal window running this script, and says whether one could be opened.
 * On a machine with no screen, set CEASENET_NO_TERMINALS=1 and the agents run in the background instead.
 */
export function openTerminal(script: string): boolean {
  if (process.env.CEASENET_NO_TERMINALS === "1") return false
  const opened = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { stdio: "ignore", windowsHide: false })
    return !result.error && result.status === 0
  }
  if (process.platform === "win32") return opened("cmd", ["/c", "start", "", script])
  if (process.platform === "darwin") return opened("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(`sh ${shellQuote(script)}`)}`])
  for (const [command, flag] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xterm", "-e"]] as const) {
    if (spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status !== 0) continue
    nodeSpawn(command, [flag, "sh", script], { detached: true, stdio: "ignore" }).unref()
    return true
  }
  return false
}

/** What a terminal runs: the agent, then a note that stays on screen, so the reason it closed can still be read. */
export function terminalScript(platform: NodeJS.Platform, title: string, env: Record<string, string>, command: string[]): string {
  if (platform === "win32") {
    const safe = (text: string) => text.replace(/%/g, "%%")
    return [
      "@echo off",
      "chcp 65001 >nul",
      `title ${title}`,
      ...Object.entries(env).map(([k, v]) => `set "${k}=${safe(v)}"`),
      command.map((c) => `"${safe(c)}"`).join(" "),
      "echo.",
      "echo This agent has ended. Press any key to close this window.",
      "pause >nul",
      "",
    ].join("\r\n")
  }
  return [
    ...Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
    `printf '\\033]0;${title}\\007'`,
    command.map(shellQuote).join(" "),
    "echo",
    "echo 'This agent has ended. Press Enter to close this window.'",
    "read _",
    "",
  ].join("\n")
}

export function startMember(member: Member, mainHome: string, self: { command: string; args: string[] }, tools: PreparedTool[]): void {
  const home = memberHome(member.id)
  const toolsFile = join(home, "tools.json")
  writeAtomic(toolsFile, JSON.stringify(tools.filter((t) => member.tools.includes(t.id)).map((t) => t.file)))
  const run = [...self.args, "agent-run", "--id", member.id, "--tools-file", toolsFile]
  const env = { CEASENET_HOME: home, CEASENET_MAIN_HOME: mainHome, CEASENET_NO_DAEMON: "1" }

  const script = join(home, process.platform === "win32" ? "terminal.cmd" : "terminal.sh")
  writeFileSync(script, terminalScript(process.platform, member.name, { ...env, CEASENET_TERMINAL: "1" }, [self.command, ...run]))
  if (openTerminal(script)) return

  const child = nodeSpawn(self.command, run, {
    // On Windows a detached process has no console, so everything it starts would open a window of its own.
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  child.unref()
}

/** Ends an agent without any recall, along with whatever it was running. */
export function shutDownMember(member: Member): void {
  const home = memberHome(member.id)
  const state = readAgentState(home)
  if (!state || !isAlive(state.pid)) return
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(state.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  else {
    try {
      process.kill(state.pid, "SIGTERM")
    } catch {
      // It has already gone.
    }
  }
  writeAgentState(home, { ...state, phase: "off", job: undefined, updatedAt: Date.now() })
}

// ---- What the console shows ----

export interface MemberView {
  id: string
  name: string
  does: string
  tools: ToolId[]
  address?: Hex
  state?: AgentState
  /** Whether its process is really still there, by asking the system rather than the agent. */
  alive: boolean
  calls: CallRecord[]
  guards: GuardStatus[]
  results: { name: string; at: number; preview: string }[]
  resultCount: number
  events: AgentEvent[]
}

/** The newest things an agent has written. Only ever from the folder its tools can reach. */
function latestResults(home: string, limit = 3): { items: MemberView["results"]; count: number } {
  const dir = join(workspaceOf(home), "outbox")
  if (!existsSync(dir)) return { items: [], count: 0 }
  const names = readdirSync(dir)
  const items = names
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((f) => ({ ...f, preview: readFileSync(join(dir, f.name), "utf8").slice(0, 280) }))
  return { items, count: names.length }
}

export function memberView(member: Member): MemberView {
  const home = memberHome(member.id)
  const state = readAgentState(home)
  let address: Hex | undefined
  try {
    address = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Config).agent.address
  } catch {
    // Not made yet.
  }
  const { items, count } = latestResults(home)
  return {
    id: member.id,
    name: member.name,
    does: member.does,
    tools: member.tools,
    address,
    state,
    alive: state ? isAlive(state.pid) && state.phase !== "off" : false,
    calls: recentCalls(30, home),
    guards: liveGuards(home),
    results: items,
    resultCount: count,
    events: readAgentEvents(home),
  }
}

export const selfForFleet = selfCommand
