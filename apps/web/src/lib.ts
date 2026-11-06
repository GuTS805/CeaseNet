import { useEffect, useRef, useState } from "react"
import {
  ADDRESSES,
  ARKIV_EXPLORER,
  arkivPublicClient,
  type AgentStatus,
  type Hex,
  type LoadedFile,
  type PublicView,
  readPublicView,
} from "@ceasenet/core"

declare const __ARKIV_ACCESS_KEY__: string
declare const __DEMO_URL__: string
declare const __VERIFIER_URL__: string
declare const __SWARM_GATEWAY__: string

export const client = arkivPublicClient(__ARKIV_ACCESS_KEY__)
export const DEMO_URL = __DEMO_URL__
export const VERIFIER_URL = __VERIFIER_URL__
/** A public copy of the site, with no live agents behind it. It also reads Arkiv less often, to stay within the public endpoint's limits. */
export const HOSTED = !__DEMO_URL__
export const SWARM_GATEWAY = __SWARM_GATEWAY__.replace(/\/+$/, "")

export const swarmLink = (reference: string) => `${SWARM_GATEWAY}/bzz/${reference}`

export const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h)

export const explorerAddress = (a: string) => `${ARKIV_EXPLORER}/address/${a}`
export const explorerEntity = (k: string) => `${ARKIV_EXPLORER}/entity/${k}`

const NAMES: Record<string, string> = Object.fromEntries(
  (
    [
      [ADDRESSES.maker, "Maker of demo-mail-tool"],
      [ADDRESSES.regulator, "Security council"],
      [ADDRESSES.publisher, "Tool registry"],
      [ADDRESSES.verifier, "CeaseNet verifier"],
      [ADDRESSES.outsider, "Outsider"],
      [ADDRESSES.ownerA, "Asha Exports"],
      [ADDRESSES.ownerB, "Bandra Freight"],
      [ADDRESSES.ownerC, "Coastal Foods"],
    ] as const
  ).map(([address, name]) => [address.toLowerCase(), name]),
)

/** A readable name for the demo's keys. Names are this site's labels: the address is what counts. */
export const nameOf = (address: string) => NAMES[address.toLowerCase()] ?? shortHash(address)

export type Colour = "green" | "amber" | "red" | "grey"

export const statusColour = (status: AgentStatus | undefined): Colour =>
  status === "RUNNING" ? "green" : status === "STOPPED" ? "red" : status ? "amber" : "grey"

export const statusLabel = (status: AgentStatus | undefined): string =>
  status === "RUNNING"
    ? "Running"
    : status === "SUPERVISED"
      ? "Asks a human first"
      : status === "STOPPED"
        ? "Stopped"
        : status === "PAUSED"
          ? "Waiting for its model"
          : "Unknown"

/** Polls while the page is open and keeps the last good result if a read fails. */
export function usePoll<T>(read: () => Promise<T>, everyMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await latest.current()
        if (live) {
          setData(next)
          setError(undefined)
        }
      } catch (e) {
        if (live) setError((e as Error).message.split("\n")[0])
      }
      if (live) timer = setTimeout(tick, everyMs)
    }
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [everyMs, ...deps])
  return { data, error }
}

/** Everything public, read straight from Arkiv with no server of ours in between. */
export const usePublicView = (everyMs = 2500) => usePoll<PublicView>(() => readPublicView(client), HOSTED ? Math.max(everyMs, 15_000) : everyMs)

export async function demoGet<T>(path: string): Promise<T> {
  const res = await fetch(DEMO_URL + path)
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error)
  return (await res.json()) as T
}

export async function demoPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(DEMO_URL + path, { method: "POST", body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error((json as { error: string }).error)
  return json as T
}

export type CallVerdict = "ALLOW" | "NEEDS_APPROVAL" | "BLOCK"

export interface FeedItem {
  id: number
  at: number
  kind: "job" | "allowed" | "blocked" | "approved" | "refused" | "said" | "problem" | "update"
  text: string
  requestId?: string
}

export interface DemoAgent {
  id: string
  company: string
  address: Hex
  owner: Hex
  status: AgentStatus
  online: boolean
  tools: { file: LoadedFile; verdict: CallVerdict }[]
  followsMaker?: boolean
  jobs: number
  sent: number
  stolen: number
  drafts: number
  feed: FeedItem[]
  approval?: { tool: string; version: string; action: string; reason: string; since: number; expiresAt: number; pass?: { userCode: string; url: string } }
  approvalNote?: string
  fixAvailable: boolean
  vanished: Hex[]
  diary: { entries: number; waiting: number; parts: { root: string }[]; lastError?: string }
  problem?: string
}

export interface StolenMail {
  company: string
  to: string
  subject: string
  body: string
  at: number
}

export interface DemoState {
  brainSource: "model" | "dev"
  model: string
  timers: { checkIntervalMs: number }
  idle: boolean
  stolenMail: StolenMail[]
  tools: { bad: LoadedFile; fixed: LoadedFile; files: LoadedFile }
  swarm: { on: boolean; evidenceReady: boolean }
  worldIdApprovals: boolean
  agents: DemoAgent[]
}
