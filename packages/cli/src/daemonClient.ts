import { spawn } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import type { ApprovalResult, Approver } from "@ceasenet/guard"
import { type Config, inHome, loadConfig } from "./home"

export interface DaemonInfo {
  pid: number
  port: number
  token: string
}

declare const __CEASENET_BUILD__: string | undefined

/** Which build of this program is running, so a console can tell when it has been replaced on disk. */
export const daemonBuild = (): string => (typeof __CEASENET_BUILD__ === "string" ? __CEASENET_BUILD__ : "dev")

/** The build of the console now running, or nothing if it is too old to say. */
export async function runningBuild(info: DaemonInfo): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1000), headers: { "x-ceasenet-token": info.token } })
    return ((await res.json()) as { build?: string }).build
  } catch {
    return undefined
  }
}

export function readDaemonInfo(): DaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(inHome("daemon.json"), "utf8")) as DaemonInfo
  } catch {
    return undefined
  }
}

export async function daemonAlive(info: DaemonInfo | undefined = readDaemonInfo()): Promise<boolean> {
  if (!info) return false
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1000), headers: { "x-ceasenet-token": info.token } })
    return res.ok
  } catch {
    return false
  }
}

/** How to start this same program again, wherever it was installed. */
export const selfCommand = (): { command: string; args: string[] } => ({
  command: process.execPath,
  args: [...process.execArgv, realpathSync(process.argv[1]!)],
})

/** Starts the console in the background. If two guards try at once, the port lets only one succeed. */
export async function startDaemonIfNeeded(_config: Config): Promise<void> {
  if (process.env.CEASENET_NO_DAEMON === "1" || (await daemonAlive())) return
  const self = selfCommand()
  // On Windows a detached process has no console, so everything it starts would open a window of its own.
  spawn(self.command, [...self.args, "daemon"], { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true }).unref()
}

export async function waitForDaemon(ms = 10_000): Promise<DaemonInfo> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const info = readDaemonInfo()
    if (info && (await daemonAlive(info))) return info
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("the console did not start")
}

/** Puts a waiting call in front of the person at the console. With nobody reachable, the answer is no. */
export const approverFromDaemon =
  (server: string): Approver =>
  async (request, signal): Promise<ApprovalResult> => {
    try {
      if (!(await daemonAlive())) {
        await startDaemonIfNeeded(loadConfig())
        await waitForDaemon(5_000)
      }
      const info = readDaemonInfo()!
      const res = await fetch(`http://127.0.0.1:${info.port}/api/approvals`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-ceasenet-token": info.token },
        body: JSON.stringify({ server, tool: request.file.name, version: request.file.version, action: request.action, reason: request.reason, details: request.details }),
      })
      if (!res.ok) return "EXPIRED"
      return ((await res.json()) as { result: ApprovalResult }).result
    } catch {
      return "EXPIRED"
    }
  }
