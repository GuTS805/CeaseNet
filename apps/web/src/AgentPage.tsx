import { useState } from "react"
import { deletedStops, type Hex, type DiaryRow, readDiaryIndex, recallCovers, statusColourOf } from "@ceasenet/core"
import { decodePart, type DiaryCheck, type DiaryEntry, verifyPart } from "@ceasenet/guard/diary"
import { client, explorerAddress, nameOf, shortHash, statusLabel, useNetworkView, usePoll } from "./lib"

const HEAD: Record<string, string> = {
  green: "Running",
  amber: "Asks a human first, or waiting",
  red: "Stopped",
  grey: "Unknown",
}

const INDEXER = "https://indexer-storage-testnet-turbo.0g.ai"

function DiaryPart({ part }: { part: DiaryRow }) {
  const [result, setResult] = useState<{ check: DiaryCheck; entries: DiaryEntry[] } | { failed: string }>()
  const [loading, setLoading] = useState(false)

  const read = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${INDEXER}/file?root=${encodeURIComponent(part.root)}`)
      const entries = decodePart(new Uint8Array(await res.arrayBuffer()))
      setResult({ check: verifyPart(entries, part.head), entries })
    } catch (e) {
      setResult({ failed: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="diary-part">
      <div className="row between">
        <span>
          Entries {String(part.firstSeq)} to {String(part.lastSeq)} <span className="mono muted">{shortHash(part.root)}</span>
        </span>
        <button disabled={loading} onClick={() => void read()}>
          {loading ? "Reading…" : "Read from 0G and check"}
        </button>
      </div>
      {result && "failed" in result && <div className="error">Could not read it: {result.failed}</div>}
      {result && "check" in result && (
        <>
          <div className={`status ${result.check.ok ? "green" : "red"}`} style={{ marginTop: 6 }}>
            {result.check.ok ? `Matches Arkiv: ${result.check.entries} entries, unchanged` : `Does not match Arkiv: ${result.check.problem}`}
          </div>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {result.entries.slice(0, 40).map((e) => (
                <tr key={e.seq}>
                  <td className="mono muted">{e.seq}</td>
                  <td>
                    {e.kind === "CALL" ? (
                      <>
                        {`${e.action} on ${e.tool} ${e.version}: ${e.allowed ? "allowed" : "refused"}${e.approval ? ` (${e.approval.toLowerCase()})` : ""}`}
                        {e.message && <div className="small muted">{e.message}</div>}
                        {e.args !== undefined ? (
                          <details>
                            <summary className="small muted">See what it sent and got back</summary>
                            <pre className="small">{JSON.stringify({ sent: e.args, got: e.result }, null, 2)}</pre>
                          </details>
                        ) : e.sealed ? (
                          <div className="small muted">Contents sealed to the owner's key. Hash {shortHash(e.argsHash)}</div>
                        ) : null}
                      </>
                    ) : e.kind === "NOTE"
                      ? e.text
                      : e.kind === "RECEIPT"
                        ? `Receipt posted: ${e.action.toLowerCase()}`
                        : e.kind === "STATUS"
                          ? `Status: ${e.from.toLowerCase()} to ${e.to.toLowerCase()}`
                          : e.kind === "UPDATE"
                            ? `Moved from ${e.from} to ${e.to}`
                            : `Connection ${e.up ? "restored" : "lost"}`}
                  </td>
                  <td className="mono muted">{e.kind === "CALL" && e.requestId ? shortHash(e.requestId) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

/** What anyone can see about an agent. Only records created by the right keys are shown. */
export function AgentPage({ address }: { address: Hex }) {
  const { data: view, error } = useNetworkView(3000)
  const owner = view?.agents.find((a) => a.agent.agent.toLowerCase() === address.toLowerCase())?.agent.owner
  const { data: diaries } = usePoll<DiaryRow[]>(() => readDiaryIndex(client, address, owner), 8000, [address, owner])

  if (error && !view) return <div className="page notice bad">Cannot read Arkiv: {error}</div>
  if (!view) return <div className="page muted">Reading Arkiv…</div>
  const entry = view.agents.find((a) => a.agent.agent.toLowerCase() === address.toLowerCase())
  if (!entry) {
    return (
      <div className="page">
        <div className="notice bad">
          No owner we know of has registered this agent. A passport anyone else wrote would not count.
        </div>
      </div>
    )
  }

  const colour = statusColourOf(address, entry.heartbeat)
  const files = entry.loadout?.files ?? []
  const open = view.recalls.filter((r) => files.some((f) => recallCovers(r, f)))
  const mine = view.acks.filter((a) => a.creator.toLowerCase() === address.toLowerCase())
  const deleted = deletedStops(mine, view.recalls)

  return (
    <div className="page">
      <div className="plate">
        <div className={`plate-head ${colour}`}>{HEAD[colour]}</div>
        <div className="plate-body">
          <div className="field">
            <div className="label">Agent</div>
            <div className="big">{entry.agent.name}</div>
            <div className="muted">{entry.agent.purpose}</div>
          </div>

          <div className="field">
            <div className="label">Responsible owner</div>
            <div>
              {nameOf(entry.agent.owner)}{" "}
              <a className="mono" href={explorerAddress(entry.agent.owner)} target="_blank" rel="noreferrer">
                {shortHash(entry.agent.owner)}
              </a>
            </div>
          </div>

          <div className="field">
            <div className="label">Fingerprint</div>
            {entry.loadout?.fingerprint ? (
              <div className="mono" title="What this agent is made of: its exact tools, model and instructions. Any change gives a new one.">
                {entry.loadout.fingerprint}
              </div>
            ) : (
              <div className="muted">Not published</div>
            )}
          </div>

          <div className="field">
            <div className="label">Heartbeat</div>
            {entry.heartbeat ? (
              <div>
                {statusLabel(entry.heartbeat.mode)}, updated {Math.max(0, Number(view.block - entry.heartbeat.updatedAt) * 2)} s ago
              </div>
            ) : (
              <div>None. Nobody can vouch for this agent right now.</div>
            )}
          </div>

          <div className="field">
            <div className="label">Loaded</div>
            <table>
              <tbody>
                {files.map((f) => (
                  <tr key={f.hash}>
                    <td className="muted small">{f.kind}</td>
                    <td>
                      {f.name} <span className="muted">{f.version}</span>
                    </td>
                    <td className="mono muted">{shortHash(f.hash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="field">
            <div className="label">Obeys STOPs from</div>
            {entry.policy ? (
              <div>{entry.policy.issuers.map(nameOf).join(", ") || "Nobody"}</div>
            ) : (
              <div className="muted">No trust list published</div>
            )}
          </div>

          <div className="field">
            <div className="label">Recalls on what it loads</div>
            {open.length === 0 ? (
              <div>None</div>
            ) : (
              open.map((r) => (
                <div key={r.key}>
                  <a href={`#/recall/${r.key}`}>{r.level === "STOP" ? "STOP" : "Warning"}</a>: {r.reason}
                </div>
              ))
            )}
          </div>

          {deleted.length > 0 && (
            <div className="notice bad">
              This agent obeyed a STOP that its issuer has since deleted ({shortHash(deleted[0]!.recall)}). The agent keeps obeying
              it, and its receipt keeps the proof.
            </div>
          )}

          <div className="field">
            <div className="label">Diary on 0G Storage</div>
            {diaries && diaries.length > 0 ? (
              diaries.slice(0, 5).map((d) => <DiaryPart key={d.key} part={d} />)
            ) : (
              <div className="muted">Nothing stored yet</div>
            )}
          </div>

          <div className="small">
            <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
              See this agent's records on the Arkiv explorer
            </a>
            {" · "}
            <a href={`#/report/${address}`}>Report this agent</a>
          </div>
        </div>
      </div>
    </div>
  )
}
