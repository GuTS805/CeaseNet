import { useEffect, useMemo, useRef, useState } from "react"
import { DEMO_AGENTS, followersOf, follows, isWithdrawn, lower, type PublicView, recallCovers, type RecallRow, trustFromPolicy } from "@ceasenet/core"
import { client, nameOf, shortHash, statusColour, statusLabel, useNetworkView, usePoll } from "./lib"
import { type ChainRecord, recordsIn, ViewTracker } from "./warroom/events"
import { Ticker } from "./warroom/Ticker"
import { cometOn } from "./warroom/WarMap"

const W = 1200
const ROW = 92
const TOP = 26
const ISSUER_X = 150
const AGENT_X = 880
const MAX_NODES = 10

const isDemo = (agent: string) => DEMO_AGENTS.some((a) => lower(a) === lower(agent))

interface Issuer {
  key: string
  recalls: RecallRow[]
  followers: number
}

/** Keys that matter on the record: those someone follows, and those who have issued a recall. */
function issuersOf(view: PublicView): Issuer[] {
  const keys = new Set(view.recalls.map((r) => lower(r.creator)))
  for (const a of view.agents) for (const i of a.policy?.issuers ?? []) keys.add(lower(i))
  return [...keys]
    .map((key) => ({
      key,
      recalls: view.recalls.filter((r) => lower(r.creator) === key),
      followers: new Set(view.agents.filter((a) => a.policy?.issuers.some((i) => lower(i) === key)).map((a) => lower(a.agent.owner))).size,
    }))
    .sort((a, b) => b.recalls.length - a.recalls.length || b.followers - a.followers)
    .slice(0, MAX_NODES)
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (x1 + x2) / 2
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
}

/** The real graph: every line is an owner's public choice, and a red one is a STOP that binds that agent. Nothing here is drawn from a fixed list. */
export function NetworkMap({ view }: { view: PublicView }) {
  const layer = useRef<SVGGElement>(null)
  const tracker = useRef(new ViewTracker())
  const issuers = useMemo(() => issuersOf(view), [view])
  const agents = view.agents.slice(0, MAX_NODES)
  const rows = Math.max(issuers.length, agents.length, 2)
  const height = TOP * 2 + rows * ROW
  const yFor = (i: number, count: number) => TOP + ((rows * ROW) / count) * (i + 0.5)
  const issuerY = (key: string) => yFor(issuers.findIndex((x) => x.key === key), issuers.length)
  const agentY = (agent: string) => yFor(agents.findIndex((a) => lower(a.agent.agent) === lower(agent)), agents.length)

  const lit = (issuer: Issuer, a: PublicView["agents"][number]) =>
    issuer.recalls.some(
      (r) =>
        r.level === "STOP" &&
        follows(a.policy, r) &&
        !isWithdrawn(r, view.lifts, trustFromPolicy(a.policy ?? { issuers: [], regulators: [], verifier: r.creator, threshold: 3 })) &&
        (a.loadout?.files.some((f) => recallCovers(r, f)) ?? false),
    )

  // Only a new record on Arkiv sets anything moving.
  useEffect(() => {
    const target = layer.current
    if (!target) return
    for (const e of tracker.current.next(view)) {
      if (e.kind === "recall") {
        const from = issuers.find((i) => i.key === lower(e.row.creator))
        if (!from) continue
        for (const a of agents) {
          if (a.policy?.issuers.some((i) => lower(i) === from.key)) {
            void cometOn(target, curve(ISSUER_X + 150, issuerY(from.key), AGENT_X - 150, agentY(a.agent.agent)), e.row.level === "STOP" ? "red" : "amber", 900)
          }
        }
      } else if (e.kind === "receipt" && agents.some((a) => lower(a.agent.agent) === lower(e.row.agent))) {
        if (issuers.some((i) => i.key === lower(e.row.issuer))) {
          void cometOn(target, curve(AGENT_X - 150, agentY(e.row.agent), ISSUER_X + 150, issuerY(lower(e.row.issuer))), e.row.action === "UPDATED" ? "teal" : "white", 900)
        }
      }
    }
  }, [view])

  return (
    <div className="net-map" style={{ aspectRatio: `${W} / ${height}` }}>
      <svg viewBox={`0 0 ${W} ${height}`} aria-hidden="true">
        {issuers.flatMap((issuer) =>
          agents
            .filter((a) => a.policy?.issuers.some((i) => lower(i) === issuer.key))
            .map((a) => (
              <path
                key={`${issuer.key}:${a.agent.agent}`}
                data-agent={lower(a.agent.agent)}
                d={curve(ISSUER_X + 150, issuerY(issuer.key), AGENT_X - 150, agentY(a.agent.agent))}
                pathLength={100}
                className={`net-line ${lit(issuer, a) ? "bound" : ""}`}
              />
            )),
        )}
        <g ref={layer} />
        <text x={W / 2} y={height / 2 - 6} className="net-hub">
          ARKIV
        </text>
        <text x={W / 2} y={height / 2 + 14} className="net-hub-block">
          block {String(view.block)}
        </text>
      </svg>
      {issuers.map((i) => (
        <div key={i.key} className={`net-node issuer ${i.recalls.some((r) => r.level === "STOP") ? "hot" : ""}`} style={{ left: `${((ISSUER_X - 150) / W) * 100}%`, top: `${(issuerY(i.key) / height) * 100}%` }}>
          <b>{nameOf(i.key)}</b>
          <span className="mono">{shortHash(i.key)}</span>
          <span>
            {i.recalls.length} recall{i.recalls.length === 1 ? "" : "s"}, {i.followers} following
          </span>
        </div>
      ))}
      {agents.map((a) => (
        <a key={a.agent.key} href={`#/agent/${a.agent.agent}`} className="net-node agent-node" style={{ left: `${((AGENT_X - 150) / W) * 100}%`, top: `${(agentY(a.agent.agent) / height) * 100}%` }}>
          <b>{a.agent.name}</b>
          <span className={`status ${statusColour(a.heartbeat?.mode)}`}>{statusLabel(a.heartbeat?.mode)}</span>
          <span className="mono">{a.loadout?.files.filter((f) => f.kind === "tool").map((f) => `${f.name} ${f.version}`).join(", ") || "Nothing published yet"}</span>
        </a>
      ))}
      {issuers.length === 0 && agents.length === 0 && <div className="net-empty">Nothing on Arkiv yet.</div>}
    </div>
  )
}

/** Everyone on the record, read from Arkiv by this browser. A new agent shows up here the moment it registers. */
export function NetworkPage() {
  const { data: view, error } = useNetworkView()
  const { data: block } = usePoll(() => client.getBlockNumber(), 2000)
  const [records, setRecords] = useState<ReadonlyMap<string, ChainRecord>>(new Map())
  const named = useRef<(address: string) => string>(nameOf)
  useEffect(() => {
    if (!view) return
    named.current = (address) => view.agents.find((a) => lower(a.agent.agent) === lower(address))?.agent.name ?? nameOf(address)
    setRecords((known) => {
      const next = new Map(known)
      for (const r of recordsIn(view, named.current)) next.set(r.id, r)
      return next
    })
  }, [view])

  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  const liveCount = view.agents.filter((a) => a.heartbeat).length
  return (
    <div className="page network">
      <h1>The network, live</h1>
      <p className="muted">
        Every agent, key and line here comes straight from Arkiv, read by your browser with no server of ours. {view.agents.length} agents on record, {liveCount} with a live heartbeat, {view.recalls.length} recalls. A line
        is an owner's public choice to follow a key. Red means a STOP binds that agent. <a href="#/protect">Add your own.</a>
      </p>
      <NetworkMap view={view} />
      <Ticker latest={block ?? view.block} records={[...records.values()]} erased={new Set()} />
      <div className="card">
        <h2>Agents</h2>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Responsible</th>
              <th>Status</th>
              <th>Tools it loaded</th>
              <th>Follows</th>
            </tr>
          </thead>
          <tbody>
            {view.agents.map((a) => (
              <tr key={a.agent.key}>
                <td>
                  <a href={`#/agent/${a.agent.agent}`}>{a.agent.name}</a> {isDemo(a.agent.agent) && <span className="status grey">demo</span>}
                </td>
                <td>{nameOf(a.agent.owner)}</td>
                <td>
                  <span className={`status ${statusColour(a.heartbeat?.mode)}`}>{statusLabel(a.heartbeat?.mode)}</span>
                </td>
                <td>{a.loadout?.files.filter((f) => f.kind === "tool" || f.kind === "skill").map((f) => `${f.name} ${f.version}`).join(", ") ?? "Not published"}</td>
                <td>{a.policy ? a.policy.issuers.length : "No list"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Recalls, with who follows each issuer</h2>
        <table>
          <tbody>
            {view.recalls.slice(0, 50).map((r) => (
              <tr key={r.key}>
                <td>
                  <a href={`#/recall/${r.key}`}>{r.level === "STOP" ? "STOP" : "Warning"}</a>
                </td>
                <td>{r.reason}</td>
                <td>{nameOf(r.creator)}</td>
                <td>{followersOf(r, view.agents)} following</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
