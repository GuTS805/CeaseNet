import { useEffect, useRef, useState } from "react"
import {
  ADDRESSES,
  ARKIV_EXPLORER,
  arkivPublicClient,
  type AgentStatus,
  CONFIRMATION_THRESHOLD,
  CONFIRMATION_WINDOW_BLOCKS,
  demoPolicy,
  type Hex,
  type LoadedFile,
  makeTrust,
  type PublicView,
  readPublicView,
  readWholeList,
  type RecallRow,
  type TrustConfig,
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
export function usePoll<T>(read: () => Promise<T>, everyMs: number, deps: unknown[] = [], initial?: T) {
  const [data, setData] = useState<T | undefined>(initial)
  const [error, setError] = useState<string>()
  /** Whether a read has finished since this page opened, as opposed to showing what was already known. */
  const [fresh, setFresh] = useState(false)
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
          setFresh(true)
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
  const refresh = async () => {
    try {
      setData(await latest.current())
      setFresh(true)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message.split("\n")[0])
    }
  }
  return { data, error, fresh, refresh }
}

/** Everything public, read straight from Arkiv with no server of ours in between. */
export const usePublicView = (everyMs = 2500) => usePoll<PublicView>(readView, HOSTED ? Math.max(everyMs, 20_000) : everyMs, [], known?.view)

/** The list, shared between pages, so moving to another page shows it at once rather than reading it all again. */
let known: { view: PublicView; at: number } | undefined
let reading: Promise<PublicView> | undefined
const KEEP_VIEW_MS = HOSTED ? 15_000 : 1_000

function readView(): Promise<PublicView> {
  if (known && Date.now() - known.at < KEEP_VIEW_MS) return Promise.resolve(known.view)
  reading ??= (HOSTED ? readWholeList(client) : readPublicView(client))
    .then((view) => {
      known = { view, at: Date.now() }
      return view
    })
    .finally(() => {
      reading = undefined
    })
  return reading
}

/** Something has just been written, so what is known is out of date. It stays on screen until the next read. */
export const forgetView = (): void => {
  if (known) known.at = 0
}

/**
 * How to read one recall on a page that shows everyone's. Only its own issuer can end it, and on the demo's pages
 * the demo's regulator as well. Whether it binds any agent is up to that agent's owner, not this page.
 */
export const trustForRecall = (recall: RecallRow): TrustConfig => {
  const demo = demoPolicy()
  return makeTrust({
    stopKeys: [recall.creator],
    regulators: HOSTED ? [] : demo.regulators,
    verifier: recall.creator,
    threshold: CONFIRMATION_THRESHOLD,
    windowBlocks: CONFIRMATION_WINDOW_BLOCKS,
  })
}

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
