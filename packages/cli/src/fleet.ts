import { spawnSync, spawn as nodeSpawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Hex, type LoadedFile } from "@ceasenet/core"
import { modelFromEnv, modelHost } from "@ceasenet/demo/brain"
import { writeAtomic } from "@ceasenet/guard"
import spawn from "cross-spawn"
import { type CallRecord, type GuardStatus, isAlive, liveGuards, recentCalls } from "./activity"
import { selfCommand } from "./daemonClient"
import { type Config, createMemberHome, inHome } from "./home"
import { resolvePlan } from "./resolve"
import type { Settings } from "./settings"

/**
 * Three real AI agents, for seeing how this behaves before trusting it with your own.
 *
 * Each is a process of its own with its own key, doing real work with real MCP servers from npm, in a folder of its
 * own that is all those servers can reach. A real model decides each step. Each keeps reading the recall list, and
 * when a recall covers it, it closes itself and its process ends. The tasks are sample files.
 */

export type ToolId = "files" | "memory"

export interface ToolDefinition {
  id: ToolId
  /** What `npx` is asked for. */
  spec: string
  /** A person's name for it. */
  label: string
  /** The calls these agents' jobs use. Offering a model only these saves tokens on every request. */
  calls: string[]
}

export const TOOLS: Record<ToolId, ToolDefinition> = {
  files: { id: "files", spec: "@modelcontextprotocol/server-filesystem", label: "Filesystem", calls: ["read_text_file", "write_file"] },
  memory: { id: "memory", spec: "@modelcontextprotocol/server-memory", label: "Memory", calls: ["create_entities"] },
}

export interface Task {
  file: string
  content: string
}

export interface Member {
  id: string
  name: string
  does: string
  tools: ToolId[]
  /** What the agent is, in the model's own instructions. */
  role: string
  tasks: Task[]
  /** The job, given the task file and where its result goes. */
  job: (input: { task: string; result: string; n: number }) => string
}

export const SHARED_RULES =
  "Work only through your tools, one call at a time. Keep every file you write to two short lines. When you finish, reply with one short sentence saying what you did. If a tool is refused, stop at once, say why it was refused, and do not look for a way around it."

/** Every one of them uses the filesystem, so recalling it closes all three. Only two use memory, so recalling that closes two. */
export const TEAM: Member[] = [
  {
    id: "invoices",
    name: "Invoice agent",
    does: "Reads each invoice and drafts a payment reminder",
    tools: ["files", "memory"],
    role: "You chase unpaid invoices for a small company.",
    tasks: [
      { file: "invoice-1042.txt", content: "Invoice 1042. Customer: Northwind Traders. Amount: 12,400. Due: 2 weeks ago.\n" },
      { file: "invoice-1043.txt", content: "Invoice 1043. Customer: Blue Harbour Foods. Amount: 3,150. Due: 5 days ago.\n" },
      { file: "invoice-1044.txt", content: "Invoice 1044. Customer: Kestrel Freight. Amount: 8,720. Due: yesterday.\n" },
    ],
    job: ({ task, result, n }) =>
      `Job ${n}. Read the invoice at ${task}. Write a polite payment reminder for it to ${result}. Then use the memory tool create_entities to record one entity named "Reminder ${n}" of type "reminder", with one observation saying which invoice it was for.`,
  },
  {
    id: "support",
    name: "Support agent",
    does: "Reads each customer message and drafts a reply",
    tools: ["files"],
    role: "You answer customer messages for a small company.",
    tasks: [
      { file: "message-1.txt", content: "From Priya: my order arrived with a cracked lid. Can you send a replacement?\n" },
      { file: "message-2.txt", content: "From Daniel: how do I change the delivery address on my next order?\n" },
      { file: "message-3.txt", content: "From Mei: I was charged twice for the same order last week.\n" },
    ],
    job: ({ task, result, n }) => `Job ${n}. Read the customer message at ${task}. Write a short, kind reply to it at ${result}.`,
  },
  {
    id: "research",
    name: "Research agent",
    does: "Reads each note and files a one-line summary",
    tools: ["files", "memory"],
    role: "You keep short summaries of what a small team has found out.",
    tasks: [
      { file: "note-1.txt", content: "Three competitors dropped their free tier this quarter, and two raised prices by about a fifth.\n" },
      { file: "note-2.txt", content: "Customers who finish setup on the first day are far more likely to still be with us after a year.\n" },
      { file: "note-3.txt", content: "Most support tickets last month were about billing dates, not about the product itself.\n" },
    ],
    job: ({ task, result, n }) =>
      `Job ${n}. Read the note at ${task}. Write a one-line summary of it to ${result}. Then use the memory tool create_entities to record one entity named "Finding ${n}" of type "finding", with that summary as its one observation.`,
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

/** The servers an agent may use. Each goes through the gate, and each can reach only this agent's own folder. */
export function memberMcpSettings(member: Member, home: string, mainHome: string, self: { command: string; args: string[] }) {
  const workspace = workspaceOf(home)
  const env = { CEASENET_HOME: home, CEASENET_MAIN_HOME: mainHome, CEASENET_NO_DAEMON: "1" }
  const gated = (name: string, serverArgs: string[], extra: Record<string, string> = {}) => ({
    command: self.command,
    args: [...self.args, "run", "--ceasenet", "--name", name, "--", "npx", "-y", ...serverArgs],
    env: { ...env, ...extra },
  })
  const servers: Record<string, unknown> = {}
  if (member.tools.includes("files")) servers.files = gated("files", [TOOLS.files.spec, workspace])
  // By default this server keeps its data inside its own package, shared by everyone who runs that copy.
  if (member.tools.includes("memory")) servers.memory = gated("memory", [TOOLS.memory.spec], { MEMORY_FILE_PATH: join(workspace, "memory.jsonl") })
  return { mcpServers: servers }
}

export interface PreparedTool extends ToolDefinition {
  file: LoadedFile
}

/** Installs each tool once, for all the agents to share. The first time takes a moment. */
export async function prepareTools(): Promise<PreparedTool[]> {
  const prepared: PreparedTool[] = []
  for (const tool of Object.values(TOOLS)) {
    const plan = await resolvePlan("npx", ["-y", tool.spec])
    prepared.push({ ...tool, file: plan.file })
  }
  return prepared
}

export function prepareMember(member: Member, config: Config, self: { command: string; args: string[] }, mainHome: string): Config {
  const home = memberHome(member.id)
  const created = createMemberHome(home, member, config)
  for (const dir of ["inbox", "outbox"]) mkdirSync(join(workspaceOf(home), dir), { recursive: true })
  for (const task of member.tasks) {
    const path = join(workspaceOf(home), "inbox", task.file)
    if (!existsSync(path)) writeFileSync(path, task.content)
  }
  writeAtomic(mcpSettingsPath(home), JSON.stringify(memberMcpSettings(member, home, mainHome, self), null, 2))
  return created
}

// ---- Starting and ending them ----

export function startMember(member: Member, mainHome: string, self: { command: string; args: string[] }, tools: PreparedTool[]): void {
  const home = memberHome(member.id)
  const loaded = tools.filter((t) => member.tools.includes(t.id)).map((t) => t.file)
  const child = nodeSpawn(self.command, [...self.args, "agent-run", "--id", member.id, "--tools", JSON.stringify(loaded)], {
    // On Windows a detached process has no console, so everything it starts would open a window of its own.
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, CEASENET_HOME: home, CEASENET_MAIN_HOME: mainHome, CEASENET_NO_DAEMON: "1" },
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
