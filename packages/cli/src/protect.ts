import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { writeAtomic } from "@ceasenet/guard"
import { inHome } from "./home"

/** One place a client keeps its MCP servers. */
export interface ClientFile {
  client: string
  path: string
}

export interface ServerEntry {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  [key: string]: unknown
}

/** Where the MCP clients we know of keep their settings, for this user and this project. */
export function knownClientFiles(cwd = process.cwd(), home = homedir(), platform = process.platform, env = process.env): ClientFile[] {
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming")
  const desktop =
    platform === "win32"
      ? join(appData, "Claude", "claude_desktop_config.json")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json")
  const vscodeUser =
    platform === "win32"
      ? join(appData, "Code", "User", "mcp.json")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
        : join(home, ".config", "Code", "User", "mcp.json")
  return [
    { client: "Claude Code", path: join(home, ".claude.json") },
    { client: "Claude Code (this project)", path: join(cwd, ".mcp.json") },
    { client: "Claude Desktop", path: desktop },
    { client: "Cursor", path: join(home, ".cursor", "mcp.json") },
    { client: "Cursor (this project)", path: join(cwd, ".cursor", "mcp.json") },
    { client: "Windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json") },
    { client: "VS Code", path: vscodeUser },
    { client: "VS Code (this project)", path: join(cwd, ".vscode", "mcp.json") },
    { client: "Gemini CLI", path: join(home, ".gemini", "settings.json") },
  ]
}

const RUN_MARK = "run"

/** The wrapped form always says what it wraps, so undoing it needs nothing but the file itself. */
export const isWrapped = (entry: ServerEntry): boolean => {
  const args = entry.args ?? []
  return args.includes(RUN_MARK) && args.includes("--ceasenet") && args.includes("--")
}

export function wrapEntry(name: string, entry: ServerEntry, self: { command: string; args: string[] }): ServerEntry {
  return {
    ...entry,
    command: self.command,
    args: [...self.args, RUN_MARK, "--ceasenet", "--name", name, "--", entry.command!, ...(entry.args ?? [])],
  }
}

export function unwrapEntry(entry: ServerEntry): ServerEntry {
  const args = entry.args ?? []
  const split = args.indexOf("--")
  const { args: _args, ...rest } = entry
  const inner = args.slice(split + 1)
  const restored: ServerEntry = { ...rest, command: inner[0]! }
  if (inner.length > 1) restored.args = inner.slice(1)
  else restored.args = []
  return restored
}

// ---- Claude Code's own tools ----

/** Where Claude Code keeps settings that apply to every project for this user. */
export const claudeSettingsPath = (home = homedir()): string => join(home, ".claude", "settings.json")
/** Claude Code exists on this machine, whether or not it has settings yet. */
export const claudeCodePresent = (home = homedir()): boolean => existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"))

const HOOK_ARG = "hook"

/** Forward slashes and quotes work in every shell Claude Code might run this through. */
export function hookCommand(self: { command: string; args: string[] }): string {
  return `${[self.command, ...self.args].map((p) => `"${p.replace(/\\/g, "/")}"`).join(" ")} ${HOOK_ARG}`
}

const isOurHook = (hook: { command?: unknown }): boolean => typeof hook.command === "string" && hook.command.endsWith(` ${HOOK_ARG}`) && /ceasenet/i.test(hook.command)

interface HookGroup {
  matcher?: string
  hooks?: { type?: string; command?: string }[]
}

const preToolUse = (root: Json): HookGroup[] => {
  const hooks = root.hooks as { PreToolUse?: HookGroup[] } | undefined
  return hooks?.PreToolUse ?? []
}

export function hasStopHook(path = claudeSettingsPath()): boolean {
  if (!existsSync(path)) return false
  const { root } = readJson(path)
  return root ? preToolUse(root).some((g) => g.hooks?.some(isOurHook)) : false
}

/** Makes "stop this agent" reach Claude Code's built-in tools as well. Everything else in the file stays as it was. */
export function addStopHook(self: { command: string; args: string[] }, path = claudeSettingsPath()): ChangeResult {
  const name = "built-in tools"
  let root: Json = {}
  let backup: string | undefined
  if (existsSync(path)) {
    const read = readJson(path)
    if (!read.root) return { changed: [], remote: [], problem: read.problem }
    root = read.root
    if (preToolUse(root).some((g) => g.hooks?.some(isOurHook))) return { changed: [], remote: [] }
    backup = backUp(path)
  }
  const hooks = (root.hooks ?? {}) as Record<string, unknown>
  root.hooks = { ...hooks, PreToolUse: [...preToolUse(root), { matcher: "*", hooks: [{ type: "command", command: hookCommand(self) }] }] }
  writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`)
  return { changed: [name], remote: [], backup }
}

export function removeStopHook(path = claudeSettingsPath()): ChangeResult {
  if (!existsSync(path)) return { changed: [], remote: [] }
  const { root, problem } = readJson(path)
  if (!root) return { changed: [], remote: [], problem }
  const groups = preToolUse(root)
  if (!groups.some((g) => g.hooks?.some(isOurHook))) return { changed: [], remote: [] }
  const backup = backUp(path)
  const kept = groups.flatMap((g) => {
    const others = g.hooks?.filter((h) => !isOurHook(h))
    return others && others.length > 0 ? [{ ...g, hooks: others }] : []
  })
  const hooks = { ...(root.hooks as Record<string, unknown>) }
  if (kept.length > 0) hooks.PreToolUse = kept
  else delete hooks.PreToolUse
  if (Object.keys(hooks).length > 0) root.hooks = hooks
  else delete root.hooks
  writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`)
  return { changed: ["built-in tools"], remote: [], backup }
}

export type EntryState = "protected" | "unprotected" | "remote"

export interface FoundServer {
  name: string
  scope: string
  state: EntryState
  entry: ServerEntry
}

const stateOf = (entry: ServerEntry): EntryState => {
  if (!entry.command) return "remote"
  return isWrapped(entry) ? "protected" : "unprotected"
}

type Json = Record<string, unknown>

/** Every block of MCP servers inside one settings file. Claude Code keeps one per project as well as its own. */
function serverBlocks(root: Json): { scope: string; block: Record<string, ServerEntry> }[] {
  const blocks: { scope: string; block: Record<string, ServerEntry> }[] = []
  const add = (scope: string, block: unknown) => {
    if (block && typeof block === "object" && !Array.isArray(block)) blocks.push({ scope, block: block as Record<string, ServerEntry> })
  }
  add("", root.mcpServers)
  // VS Code calls the same thing "servers".
  add("", root.servers)
  const projects = root.projects
  if (projects && typeof projects === "object") {
    for (const [project, settings] of Object.entries(projects as Record<string, Json>)) add(project, settings?.mcpServers)
  }
  return blocks
}

function readJson(path: string): { root?: Json; problem?: string } {
  try {
    return { root: JSON.parse(readFileSync(path, "utf8")) as Json }
  } catch (e) {
    return { problem: `could not be read as plain JSON, so it was left alone: ${(e as Error).message.split("\n")[0]}` }
  }
}

export interface FileReport {
  client: string
  path: string
  servers: FoundServer[]
  problem?: string
}

export function inspectFile(file: ClientFile): FileReport {
  const { root, problem } = readJson(file.path)
  if (!root) return { ...file, servers: [], problem }
  const servers = serverBlocks(root).flatMap(({ scope, block }) =>
    Object.entries(block).map(([name, entry]) => ({ name, scope, state: stateOf(entry), entry })),
  )
  return { ...file, servers }
}

export const inspectAll = (files: readonly ClientFile[]): FileReport[] => files.filter((f) => existsSync(f.path)).map(inspectFile)

function backUp(path: string): string {
  const dir = inHome("backups")
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(path)}`)
  copyFileSync(path, copy)
  return copy
}

export interface ChangeResult {
  changed: string[]
  remote: string[]
  backup?: string
  problem?: string
}

/** Rewrites one settings file. Anything else in the file stays exactly as it was, and a copy is kept first. */
function changeFile(path: string, change: (name: string, entry: ServerEntry) => ServerEntry | undefined): ChangeResult {
  const { root, problem } = readJson(path)
  if (!root) return { changed: [], remote: [], problem }
  const changed: string[] = []
  const remote: string[] = []
  for (const { block } of serverBlocks(root)) {
    for (const [name, entry] of Object.entries(block)) {
      if (!entry.command) {
        remote.push(name)
        continue
      }
      const next = change(name, entry)
      if (next) {
        block[name] = next
        changed.push(name)
      }
    }
  }
  if (changed.length === 0) return { changed, remote }
  const backup = backUp(path)
  writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`)
  return { changed, remote, backup }
}

export const protectFile = (path: string, self: { command: string; args: string[] }): ChangeResult =>
  changeFile(path, (name, entry) => (isWrapped(entry) ? undefined : wrapEntry(name, entry, self)))

export const unprotectFile = (path: string): ChangeResult => changeFile(path, (_name, entry) => (isWrapped(entry) ? unwrapEntry(entry) : undefined))
