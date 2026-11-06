import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { LoadedFile } from "@ceasenet/core"
import { writeAtomic } from "@ceasenet/guard"
import { homeDir, inHome, safeName } from "./home"
import type { Strength } from "./resolve"

/**
 * What the guards on this machine are doing, kept in plain files.
 *
 * A guard makes every decision on its own and needs nothing else running. The console and reporter only read
 * these, so they can be stopped or crash without one call being let through.
 */

export interface CallRecord {
  at: number
  server: string
  tool: string
  version: string
  action: string
  allowed: boolean
  verdict: string
  approval?: string
  message: string
  gateMs: number
}

const LOG = "activity.jsonl"
const MAX_LOG_BYTES = 2_000_000

/** Records that a call happened and what was decided. Never what was in it. */
export function recordCall(record: CallRecord): void {
  mkdirSync(inHome(), { recursive: true })
  const path = inHome(LOG)
  if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}

export function recentCalls(limit = 100, home = homeDir()): CallRecord[] {
  const path = join(home, LOG)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  return lines
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CallRecord]
      } catch {
        return []
      }
    })
    .reverse()
}

/** One guard, as it describes itself. */
export interface GuardStatus {
  pid: number
  server: string
  file: LoadedFile
  strength: Strength
  /** The tool's own process. Absent means it has been ended, or was never started. */
  toolPid?: number
  recall?: { key: string; reason: string; issuer: string; artifact: string }
  blockedLocally?: string
  online: boolean
  mode: "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"
  message?: string
  startedAt: number
  updatedAt: number
}

const statusPath = (status: Pick<GuardStatus, "server" | "pid">) => inHome("guards", `${safeName(status.server)}-${status.pid}.json`)

export const writeStatus = (status: GuardStatus): void => writeAtomic(statusPath(status), JSON.stringify(status))

export function removeStatus(status: Pick<GuardStatus, "server" | "pid">): void {
  rmSync(statusPath(status), { force: true })
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // It exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Every guard still running on this machine. Files left behind by one that died are cleared away. */
export function liveGuards(home = homeDir()): GuardStatus[] {
  const dir = join(home, "guards")
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (!name.endsWith(".json")) return []
    const path = `${dir}/${name}`
    try {
      const status = JSON.parse(readFileSync(path, "utf8")) as GuardStatus
      if (isAlive(status.pid)) return [status]
      rmSync(path, { force: true })
    } catch {
      // Being written right now, or unreadable. Either way there is nothing to report from it this time.
    }
    return []
  })
}
