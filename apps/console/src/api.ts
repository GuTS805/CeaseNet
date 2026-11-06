import { useCallback, useEffect, useRef, useState } from "react"

const token = document.querySelector<HTMLMetaElement>('meta[name="ceasenet-token"]')?.content ?? ""

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-ceasenet-token": token } })
  // The console has restarted and has a new token, which the page gets by loading again.
  if (res.status === 401 && Date.now() - Number(sessionStorage.getItem("reloaded") ?? 0) > 3000) {
    sessionStorage.setItem("reloaded", String(Date.now()))
    location.reload()
  }
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `The console answered ${res.status}`)
  return body
}

export const post = <T,>(path: string, body: unknown = {}): Promise<T> => request<T>(path, { method: "POST", body: JSON.stringify(body) })

/** Reads one thing again and again while a page is open, and keeps the last good answer if a read fails. */
export function usePoll<T>(path: string, everyMs: number) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    try {
      setData(await request<T>(path))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [path])
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      await refresh()
      if (live) timer = setTimeout(tick, everyMs)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [everyMs, refresh])
  return { data, error, refresh }
}

// ---- The three agents ----

export interface AgentEvent {
  at: number
  kind: "started" | "check" | "job" | "said" | "closed" | "problem" | "paused"
  text: string
}

export interface AgentSelf {
  id: string
  name: string
  pid: number
  phase: "starting" | "working" | "idle" | "paused" | "waiting" | "closing" | "closed" | "off"
  jobs: number
  job?: string
  lastSaid?: string
  checks: number
  lastCheck?: { at: number; block: string; online: boolean; tookMs: number; stopsRead: number }
  closed?: { at: number; reason: string; recall?: string; artifact?: string; tool?: string; afterStart: boolean }
  problem?: string
}

export interface TeamMember {
  id: string
  name: string
  does: string
  tools: string[]
  address?: string
  state?: AgentSelf
  alive: boolean
  calls: Call[]
  guards: { pid: number; server: string; toolPid?: number }[]
  results: { name: string; at: number; preview: string }[]
  resultCount: number
  events: AgentEvent[]
  closedAfterMs?: number
  recallEnded?: boolean
  recallMine?: boolean
  receiptPosted: boolean
}

export interface TeamTool {
  id: string
  label: string
  spec: string
  file: { kind: string; name: string; version: string; hash: string }
  usedBy: string[]
  recall?: { key: string; reason: string; mine: boolean }
}

export interface TeamState {
  network: "arkiv" | "local"
  block?: string
  thinking?: { kind: "api"; model: string; host: string; requestsPerMinute: number } | { kind: "claude"; model: string; version?: string }
  /** What they can be switched to. */
  choices: { value: string; label: string }[]
  choice?: string
  preparing?: string
  startError?: string
  members: TeamMember[]
  tools: TeamTool[]
  teamRecall?: { key: string; reason: string }
  canSign: boolean
}

// ---- The diary ----

export interface DiaryAgent {
  id: string
  name: string
  address: string
  mode: "public" | "sealed" | "hashes"
  entries: number
  parts: number
  lastStoredAt?: number
  waiting: number
  problem?: string
}

export interface DiaryList {
  where: "0g" | "local"
  wallet?: { address: string; balance?: string; low: boolean }
  problem?: string
  faucet: string
  agents: DiaryAgent[]
}

export type DiaryItem = { seq: number; at: number; prev: string } & (
  | {
      kind: "CALL"
      tool: string
      version: string
      action: string
      argsHash: string
      resultHash?: string
      verdict: string
      allowed: boolean
      approval?: string
      message?: string
      args?: unknown
      result?: unknown
      sealed?: string
      clipped?: boolean
      opened?: { args: unknown; result?: unknown }
    }
  | { kind: "NOTE"; note: string; text: string }
  | { kind: "STATUS" | "RECEIPT" | "UPDATE" | "NETWORK" }
)

export interface DiaryPart {
  root: string
  head: string
  firstSeq: number
  lastSeq: number
  entries: number
  block: string
  check: { ok: boolean; problem?: string }
  followsOn?: boolean
  items: DiaryItem[]
}

export interface DiaryRead {
  id: string
  name: string
  address: string
  mode: DiaryAgent["mode"]
  where: "0g" | "local"
  totalParts: number
  canOpenSealed: boolean
  parts: DiaryPart[]
}

// ---- Reports from people ----

export interface ReportView {
  key: string
  artifact: string
  reason: string
  about: { agent: string; address: string; through: string }[]
  target: string
  kind: "agent" | "tool"
  votes: number
  disputes: number
  simulated: number
  votesNeeded: number
  state: "collecting" | "waiting" | "recalled" | "dismissed"
  versions?: string
}

export interface ReportsState {
  reports: ReportView[]
  problem?: string
  votesNeeded: number
  verifier: string
}

// ---- Arkiv and the other services ----

export interface RecordRow {
  type: string
  key?: string
  creator: string
  block?: string
  summary: string
  link?: string
}

export interface ArkivState {
  mode: "arkiv" | "local"
  chain: { name: string; chainId: number; rpc: string; explorer: string; reachable: boolean; block?: string; latencyMs?: number; error?: string; accessKey: boolean }
  publicList?: { recalls: number; stops: number; warnings: number; agents: number; receipts: number; lifts: number; files: number }
  wallets: { role: string; address: string; balance?: string; empty?: boolean; link: string }[]
  agents: {
    name: string
    address: string
    owner?: string
    registered: boolean
    fingerprint?: string
    tools: { name: string; version: string; hash: string }[]
    made: { kind: string; name: string; hash: string }[]
    status?: string
    diaryParts: number
    diaryEntries: number
    link: string
  }[]
  records: Record<string, RecordRow[]>
  gateQuery: { issuers: string[]; verifier: string; text: string }
  canGoPublic: boolean
  goPublicBlockedBy?: string
}

export interface ServiceCard {
  id: string
  name: string
  status: "working" | "ready" | "limited" | "not-set-up" | "unreachable"
  purpose: string
  found: string[]
  todo?: string
  usedBy: string
  link?: string
}

export type Mode = "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"

export interface Tool {
  name: string
  version: string
  hash: string
  strength: "pinned" | "measured" | "command"
  servers: string[]
  guards: number
  toolPids: number[]
  mode: Mode
  online: boolean
  recall?: { key: string; reason: string; issuer: string; artifact: string }
  blockedLocally?: string
  held: boolean
  calls: number
  refused: number
  lastCallAt?: number
}

export interface Call {
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

export interface Approval {
  id: string
  server: string
  tool: string
  version: string
  action: string
  reason: string
  details?: string
  since: number
  expiresAt: number
}

export interface Recall {
  key: string
  artifact: string
  level: "STOP" | "ADVISORY"
  severity: string
  reason: string
  advice?: string
  creator: string
  createdAt: string
  pkg?: string
  versions?: string
  ended: boolean
  mine: boolean
  kill: boolean
  target: string
  affectsMe: boolean
  receipts: number
  myReceipt: boolean
  fix?: { fixedVersion?: string; fixedHash?: string; note?: string }
}

export interface FleetAgent {
  agent: string
  name: string
  status?: string
  tools: { name: string; version: string; hash: string }[]
}

export interface ClientReport {
  client: string
  path: string
  problem?: string
  protected: string[]
  unprotected: string[]
  remote: string[]
}

export interface State {
  network: "arkiv" | "local"
  agent: { name: string; address: string; status: string }
  owner: { address: string; canSign: boolean }
  stoppedBy?: { key: string; reason: string; artifact: string; createdAt: string }
  tools: Tool[]
  guardsRunning: number
  calls: Call[]
  approvals: Approval[]
  problems: string[]
  notes: { at: number; text: string }[]
  clients: ClientReport[]
  reportsWaiting: { key: string; target: string; reason: string; votes: number; simulated: number }[]
  claudeCode: { present: boolean; covered: boolean }
  funds?: { owner: string; agent: string; ownerEmpty: boolean; agentEmpty: boolean }
  trust?: { issuers: string[]; regulators: string[]; verifier: string; threshold: number }
  fleet?: FleetAgent[]
  block?: string
  recalls?: Recall[]
}

export function useConsoleState(everyMs = 2000) {
  const [state, setState] = useState<State>()
  const [unreachable, setUnreachable] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const refresh = useCallback(async () => {
    try {
      setState(await request<State>("/api/state"))
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    }
  }, [])

  useEffect(() => {
    let live = true
    const tick = async () => {
      await refresh()
      if (live) timer.current = setTimeout(tick, everyMs)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer.current)
    }
  }, [everyMs, refresh])

  return { state, unreachable, refresh }
}
