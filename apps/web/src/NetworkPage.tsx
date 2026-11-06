import { useEffect, useMemo, useRef, useState } from "react"
import { DEMO_AGENTS, followersOf, isLive, lower, onlyLive, type PublicView, type RecallRow } from "@ceasenet/core"
import { client, HOSTED, nameOf, shortHash, statusColour, statusLabel, useNetworkView, usePoll } from "./lib"
import { type ChainRecord, recordsIn } from "./warroom/events"
import { Ticker } from "./warroom/Ticker"

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
}

/** Says what the map is leaving out, and brings it back with one click. */
export function LiveToggle({ view, everyone, onChange }: { view: PublicView; everyone: boolean; onChange: (everyone: boolean) => void }) {
  const others = view.agents.filter((a) => !isLive(a)).length
  if (others === 0) return null
  return (
    <label className="small muted check-line">
      <input type="checkbox" checked={everyone} onChange={(e) => onChange(e.target.checked)} /> Also show {others} agent{others === 1 ? "" : "s"} on record that {others === 1 ? "is" : "are"} not running now, such as finished test runs.
    </label>
  )
}

/** Public trust records, presented without a node diagram. */
export function NetworkMap({ view, shown = view }: { view: PublicView; shown?: PublicView }) {
  const issuers = issuersOf(shown)
  return <section className="network-records" aria-label="Network overview">
    <div className="network-figures">
      <div><span className="eyebrow">AGENTS ON RECORD</span><b>{view.agents.length}</b></div>
      <div><span className="eyebrow">LIVE HEARTBEATS</span><b>{view.agents.filter(isLive).length}</b></div>
      <div><span className="eyebrow">RECALL RECORDS</span><b>{view.recalls.length}</b></div>
      <div><span className="eyebrow">LATEST BLOCK</span><b>{String(view.block)}</b></div>
    </div>
    <div className="card"><h2>Trust, on the record.</h2><p className="muted small">Each owner chooses whose recalls to follow. A recall only binds agents whose owner follows its issuer.</p>
      {issuers.length === 0 ? <p className="muted">No issuers for the agents currently shown.</p> : <div className="issuer-list">{issuers.map(i => <div className="issuer-record" key={i.key}><div><b>{nameOf(i.key)}</b><span className="mono muted">{shortHash(i.key)}</span></div><span>{i.recalls.length} recall records</span><span>{i.followers} following owners</span></div>)}</div>}
    </div>
  </section>
}
/** Everyone on the record, read from Arkiv by this browser. A new agent shows up here the moment it registers. */
export function NetworkPage() {
  const { data: view, error } = useNetworkView()
  // Each read counts against an access key's quota. On its own, this one line was nearly half of what this page read.
  const { data: block } = usePoll(() => client.getBlockNumber(), HOSTED ? 15_000 : 2000)
  const [everyone, setEveryone] = useState(false)
  const shown = useMemo(() => view && (everyone ? view : onlyLive(view)), [view, everyone])
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

  if (error && !view) return <div className="page network"><h1>The network, live</h1><div className="notice bad" role="alert">Cannot read Arkiv: {error}</div><p className="muted">The network is temporarily unavailable. This page will retry automatically.</p></div>
  if (!view || !shown) return <div className="page network"><h1>The network, live</h1><div className="empty-state" role="status">Reading public records from Arkiv…</div></div>
  const liveCount = view.agents.filter(isLive).length
  return (
    <div className="page network">
      <h1>The network, live</h1>
      <p className="muted">
        Every agent and record here comes straight from Arkiv, read independently by your browser. {view.agents.length} agents on record, {liveCount} with a live heartbeat, {view.recalls.length} recalls. Each owner decides which issuers to follow. <a href="#/protect">Add your own.</a>
      </p>
      <LiveToggle view={view} everyone={everyone} onChange={setEveryone} />
      <NetworkMap view={view} shown={shown} />
      <Ticker latest={block ?? view.block} records={[...records.values()]} erased={new Set()} />
      <div className="card">
        <h2>Agents</h2>
        {shown.agents.length === 0 && <p className="muted">No agent is running right now.</p>}
        <table hidden={shown.agents.length === 0}>
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
            {shown.agents.map((a) => (
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
        {shown.recalls.length === 0 && (
          <p className="muted">
            None in force for the agents shown here. <a href="#/recalls">See all recalls.</a>
          </p>
        )}
        <table>
          <tbody>
            {shown.recalls.slice(0, 50).map((r) => (
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
