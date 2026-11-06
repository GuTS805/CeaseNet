import { useState } from "react"
import { type ArkivState, post, usePoll } from "./api"
import { type Ask, Copyable, type Run, short, Status, Tile } from "./ui"

const FAUCET = "https://hub.arkiv.network/faucet"
const ACCESS_KEYS = "https://hub.arkiv.network/access-keys"

function GoPublic({ view, onAsk, run }: { view: ArkivState; onAsk: (ask: Ask) => void; run: Run }) {
  if (view.mode !== "local") return null
  const owner = view.wallets[0]!
  const go = () =>
    onAsk({
      title: "Move to the public list",
      body: (
        <p>
          Recalls and receipts go on Arkiv, where anyone can read them, and where agents on any machine can obey you. The three agents shut down and you start them again. Every tool call on this machine then waits for a read from the chain, and if the chain is out of reach for 5 minutes, your agents begin to refuse.
        </p>
      ),
      confirm: "Move to the public list",
      go: () => post("/api/network", { network: "arkiv" }),
    })
  return (
    <section className="golive">
      <div>
        <h2>Your recalls are in a file on this machine</h2>
        <p className="muted">Nothing is public yet, and only agents here can obey you. Everything below about the chain is real and live, but your own records are not on it.</p>
        {view.goPublicBlockedBy && (
          <p className="small">
            {view.goPublicBlockedBy}{" "}
            {owner.empty !== false && (
              <>
                Fund <Copyable value={owner.address} /> from the{" "}
                <a href={FAUCET} target="_blank" rel="noreferrer">
                  faucet
                </a>
                , or from a funded treasury with <code>npm run fund-owner</code>.
              </>
            )}
          </p>
        )}
      </div>
      <button className="primary" disabled={!view.canGoPublic} onClick={go}>
        Move to the public list
      </button>
    </section>
  )
}

export function ArkivPage({ onAsk, run }: { onAsk: (ask: Ask) => void; run: Run }) {
  const { data: view, error } = usePoll<ArkivState>("/api/arkiv", 20_000)
  const [tab, setTab] = useState("Recalls")
  if (!view) return <div className="loading">{error ?? "Reading the chain…"}</div>

  const { chain, publicList } = view
  const rows = view.records[tab] ?? []

  return (
    <div className="page-body">
      <div className="page-title">
        <div>
          <h1>Arkiv</h1>
          <p className="muted">
            The public list that every gate reads for itself. Each number here was just read from {chain.name}, chain {chain.chainId}.
          </p>
        </div>
        <div className="page-actions">
          {chain.reachable ? <Status tone="green">Chain reachable</Status> : <Status tone="red">Chain out of reach</Status>}
          <a className="button-link" href={chain.explorer} target="_blank" rel="noreferrer">
            Open the explorer
          </a>
        </div>
      </div>

      {chain.error && <div className="notice bad">Cannot read the chain: {chain.error}</div>}

      <GoPublic view={view} onAsk={onAsk} run={run} />

      <div className="tiles">
        <Tile label="Your recalls are kept" value={view.mode === "arkiv" ? "On Arkiv" : "On this machine"} note={view.mode === "arkiv" ? "Public, and readable from anywhere" : "Private, and only agents here obey"} />
        <Tile label="Latest block" value={chain.block ?? "None"} note={chain.latencyMs !== undefined ? `Read in ${chain.latencyMs} ms` : undefined} />
        <Tile
          label="Access key"
          value={!chain.accessKey ? "None" : chain.keyExhausted ? "Used up" : "In use"}
          note={
            chain.keyExhausted ? (
              <>
                Reading through the public endpoint, which works just the same. Get a new one at the{" "}
                <a href={ACCESS_KEYS} target="_blank" rel="noreferrer">
                  Arkiv hub
                </a>
              </>
            ) : chain.accessKey ? (
              chain.keyUsedPercent !== undefined ? `${chain.keyUsedPercent}% of its quota used` : "When its quota runs out, the public endpoint takes over"
            ) : (
              <a href={ACCESS_KEYS} target="_blank" rel="noreferrer">
                Get a free one
              </a>
            )
          }
        />
        <Tile label="Everyone's recalls on the chain" value={publicList?.recalls ?? "Unknown"} note={publicList ? `${publicList.stops} ${publicList.stops === 1 ? "stop" : "stops"}, ${publicList.warnings} ${publicList.warnings === 1 ? "report" : "reports"}` : undefined} />
        <Tile label="Everyone's receipts on the chain" value={publicList?.receipts ?? "Unknown"} />
        <Tile label="Agents registered on the chain" value={publicList?.agents ?? "Unknown"} />
      </div>

      <section className="panel">
        <header>
          <h2>Agents on record</h2>
          <span className="muted small">Who each one answers to, and exactly what it is made of</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Owner</th>
              <th>Fingerprint</th>
              <th>Made of</th>
              <th className="right">Diary</th>
            </tr>
          </thead>
          <tbody>
            {view.agents.map((a) => (
              <tr key={a.address}>
                <td>
                  <div className="tool-name">{a.name}</div>
                  <Copyable value={a.address} />
                </td>
                <td className="small">{a.owner ? <Copyable value={a.owner} /> : <span className="muted">Not registered yet</span>}</td>
                <td className="small">{a.fingerprint ? <Copyable value={a.fingerprint} /> : <span className="muted">Not published yet</span>}</td>
                <td className="small why">
                  {a.tools.map((t) => `${t.name.split("/").pop()} ${t.version}`).join(", ") || "No tools published"}
                  {a.made.length > 0 && <div className="muted">{a.made.map((m) => m.name).join(", ")}</div>}
                </td>
                <td className="small right tabular">
                  <a href="#/diary">
                    {a.diaryEntries} {a.diaryEntries === 1 ? "entry" : "entries"}
                  </a>
                  <div className="muted">
                    {a.diaryParts} {a.diaryParts === 1 ? "part" : "parts"}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <header>
          <h2>Wallets</h2>
          <span className="muted small">Balances are from the chain</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>Whose</th>
              <th>Address</th>
              <th className="right">tGLM</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.wallets.map((w) => (
              <tr key={w.address}>
                <td>{w.role}</td>
                <td>
                  <Copyable value={w.address} />
                </td>
                <td className="right tabular">{w.balance ?? "Unknown"}</td>
                <td className="actions">
                  <a className="small" href={w.link} target="_blank" rel="noreferrer">
                    Explorer
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <header>
          <h2>Your records</h2>
          <span className="muted small">{view.mode === "arkiv" ? "From this owner and its agents, on Arkiv" : "From this owner and its agents, in the file on this machine"}</span>
        </header>
        <div className="tabs" role="tablist" aria-label="Kinds of record">
          {Object.entries(view.records).map(([name, list]) => (
            <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? "tab on" : "tab"} onClick={() => setTab(name)}>
              {name} <span className="tab-count">{list.length}</span>
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="empty muted">None yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>What it says</th>
                <th>Created by</th>
                <th className="right">Block</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key ?? i}>
                  <td className="small nowrap">{r.type}</td>
                  <td className="small why">{r.summary}</td>
                  <td className="small">
                    <Copyable value={r.creator} />
                  </td>
                  <td className="small right tabular">{r.block ?? ""}</td>
                  <td className="small">
                    {r.link ? (
                      <a className="mono" href={r.link} target="_blank" rel="noreferrer">
                        {short(r.key ?? "")}
                      </a>
                    ) : r.key ? (
                      <span className="mono muted">{short(r.key)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <header>
          <h2>What a gate here asks for</h2>
        </header>
        <div className="pad-body">
          <p className="small">
            Anyone can write a record with any labels, so labels prove nothing. A gate reads recalls only from these keys, because the chain itself sets who created each record, and nobody can fake that. It reads all of them and matches on this machine, so the network never learns which tools you use.
          </p>
          <ul className="plain">
            {view.gateQuery.issuers.map((issuer) => (
              <li key={issuer}>
                <Copyable value={issuer} />
              </li>
            ))}
          </ul>
          <pre className="query">{view.gateQuery.text}</pre>
        </div>
      </section>
    </div>
  )
}
