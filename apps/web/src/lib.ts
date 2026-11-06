import { useEffect, useRef, useState } from "react"
import {
  ADDRESSES,
  ARKIV_EXPLORER,
  arkivPublicClient,
  type AgentStatus,
  type BoardAgent,
  CONFIRMATION_THRESHOLD,
  CONFIRMATION_WINDOW_BLOCKS,
  countConfirmations,
  type Hex,
  type LoadedFile,
  lower,
  makeTrust,
  type PublicView,
  readWholeList,
  recallCovers,
  type RecallRow,
  type TrustConfig,
} from "@ceasenet/core"

declare const __ARKIV_ACCESS_KEY__: string
declare const __DEMO_URL__: string
declare const __VERIFIER_URL__: string
declare const __SWARM_GATEWAY__: string

export const ACCESS_KEY = __ARKIV_ACCESS_KEY__
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

const NAMES: Record<string, string> = { [ADDRESSES.verifier.toLowerCase()]: "CeaseNet verifier" }

/** A readable name for a key this site knows. Names are this site's labels: the address is what counts. */
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

/** Polls while the page is on screen, and keeps the last good result if a read fails. A tab nobody is looking at reads nothing. */
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
    let reading = false
    const tick = async () => {
      if (reading) return
      reading = true
      clearTimeout(timer)
      if (!document.hidden) {
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
      }
      reading = false
      if (live) timer = setTimeout(tick, everyMs)
    }
    // Coming back to the tab shows what is true now, rather than waiting for the next turn.
    const onShown = () => {
      if (!document.hidden) void tick()
    }
    document.addEventListener("visibilitychange", onShown)
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", onShown)
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

/** A view shared between pages, so moving to another page shows it at once rather than reading it all again. */
function sharedView(read: () => Promise<PublicView>) {
  let known: { view: PublicView; at: number } | undefined
  let reading: Promise<PublicView> | undefined
  const keepMs = HOSTED ? 15_000 : 1_000
  return {
    get known() {
      return known?.view
    },
    read(): Promise<PublicView> {
      if (known && Date.now() - known.at < keepMs) return Promise.resolve(known.view)
      reading ??= read()
        .then((view) => {
          known = { view, at: Date.now() }
          return view
        })
        .finally(() => {
          reading = undefined
        })
      return reading
    },
    forget(): void {
      if (known) known.at = 0
    },
  }
}

/**
 * The keys of the old scripted demo: its companies, their agents, and the tool maker, council and registry it played.
 * Their records are still on Arkiv until they expire, but they are not real, so this site leaves them out.
 */
const DEMO_KEYS = new Set(
  Object.entries(ADDRESSES)
    .filter(([role]) => role !== "verifier")
    .map(([, address]) => address.toLowerCase()),
)
const isDemoKey = (address: string) => DEMO_KEYS.has(address.toLowerCase())
const namesDemo = (artifact: string) => /^(agent|fleet|team):/.test(artifact) && isDemoKey(artifact.slice(artifact.indexOf(":") + 1))

/** Only real records: nothing from the old demo's keys, and no stand-in votes from test mode. */
export function withoutDemo(view: PublicView): PublicView {
  const recalls = view.recalls.filter((r) => !isDemoKey(r.creator) && !namesDemo(r.artifact))
  const kept = new Set(recalls.map((r) => r.key))
  return {
    ...view,
    agents: view.agents.filter((a) => !isDemoKey(a.agent.agent) && !isDemoKey(a.agent.owner)),
    recalls,
    acks: view.acks.filter((a) => kept.has(a.recall)),
    lifts: view.lifts.filter((l) => kept.has(l.recall)),
    endorsements: view.endorsements.filter((e) => kept.has(e.recall) && !e.human.startsWith("simulated-")),
    disclosures: view.disclosures.filter((d) => kept.has(d.recall)),
  }
}

const readReal = () => readWholeList(client).then(withoutDemo)
const publicView = sharedView(readReal)
const networkView = sharedView(readReal)

/** Everything public, read straight from Arkiv with no server of ours in between. */
export const usePublicView = (everyMs = 2500) => usePoll<PublicView>(() => publicView.read(), HOSTED ? Math.max(everyMs, 20_000) : everyMs, [], publicView.known)

/** The whole network, from anyone, with no list of keys to start from. */
export const useNetworkView = (everyMs = 4000) => usePoll<PublicView>(() => networkView.read(), HOSTED ? Math.max(everyMs, 30_000) : everyMs, [], networkView.known)

/** Something has just been written, so what is known is out of date. It stays on screen until the next read. */
export const forgetView = (): void => {
  publicView.forget()
  networkView.forget()
}

/**
 * How to read one recall on a page that shows everyone's. Only its own issuer can end it. Whether it binds an agent
 * depends on who owns that agent: an agent obeys only its owner.
 */
export const trustForRecall = (recall: RecallRow): TrustConfig =>
  makeTrust({
    stopKeys: [recall.creator],
    regulators: [],
    verifier: recall.creator,
    threshold: CONFIRMATION_THRESHOLD,
    windowBlocks: CONFIRMATION_WINDOW_BLOCKS,
  })

/** Opened by a logged-in person through the verifier. It needs votes, and binds nobody until an owner approves it. */
export const isNormalRecall = (r: RecallRow): boolean => r.level === "ADVISORY" && r.severity === "REPORT" && lower(r.creator) === lower(ADDRESSES.verifier)

/** What a recall is aimed at, if this agent has it: the agent itself, its owner's fleet, or something it loaded. */
export const coversAgent = (r: RecallRow, a: BoardAgent): boolean => {
  if (lower(r.artifact) === `agent:${lower(a.agent.agent)}`) return true
  if (lower(r.artifact) === `fleet:${lower(a.agent.owner)}` || lower(r.artifact) === `team:${lower(a.agent.owner)}`) return true
  return Boolean(a.loadout?.files.some((f) => recallCovers(r, f)))
}

/** Agents a STOP binds: those it covers whose owner signed it. */
export const boundBy = (stop: RecallRow, view: PublicView): BoardAgent[] =>
  stop.level === "STOP" ? view.agents.filter((a) => lower(a.agent.owner) === lower(stop.creator) && coversAgent(stop, a)) : []

/** Owners who can approve a normal recall, because it covers agents of theirs. */
export const ownersFor = (recall: RecallRow, view: PublicView): Map<string, BoardAgent[]> => {
  const owners = new Map<string, BoardAgent[]>()
  for (const a of view.agents) {
    if (!coversAgent(recall, a)) continue
    const owner = lower(a.agent.owner)
    owners.set(owner, [...(owners.get(owner) ?? []), a])
  }
  return owners
}

/** Owners' STOPs that approved this normal recall. */
export const approvalsOf = (recall: RecallRow, view: PublicView): RecallRow[] =>
  view.recalls.filter((r) => r.level === "STOP" && r.approves && lower(r.approves) === lower(recall.key))

/** Votes on a normal recall, one per person, within its window. */
export const votesOn = (recall: RecallRow, view: PublicView) => countConfirmations(recall, view.endorsements, view.block, trustForRecall(recall))

/** Enough people agree that the owner can approve it. */
export const enoughVotes = (recall: RecallRow, view: PublicView): boolean => {
  const v = votesOn(recall, view)
  return v.effective >= CONFIRMATION_THRESHOLD
}
