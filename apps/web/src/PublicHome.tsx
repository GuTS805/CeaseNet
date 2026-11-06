import { RecallList } from "./RecallPages"
import { nameOf, statusColour, statusLabel, useNetworkView } from "./lib"
import { NetworkMap } from "./NetworkPage"

const REPOSITORY = "https://github.com/GuTS805/CeaseNet"

/** The front page when no live agents can be reached from here. Everything on it comes straight from Arkiv. */
export function PublicHome() {
  const { data: view, error } = useNetworkView()
  return (
    <div className="page home">
      <section className="home-hero">
        <h1>Recalls for AI agents</h1>
        <p className="home-lead">
          When a tool an AI agent uses turns out to be malicious, taking it off the marketplace doesn't stop agents that already have it. CeaseNet is a public recall list on Arkiv that agents check for
          themselves. A STOP blocks that one tool within seconds, and each agent posts a public receipt.
        </p>
        <div className="buttons home-actions">
          <a className="button primary" href="#/protect">
            Protect an agent
          </a>
          <a className="button" href="#/issue">
            Recall a tool
          </a>
          <a className="button" href="#/network">
            See the network
          </a>
          <a className="button" href="#/check">
            Check a tool
          </a>
        </div>
        <img className="home-shot" src="./war-room.png" alt="The live demo: three companies' agents, a stranger's inbox that has gone silent, and a measured time from pressing STOP to blocked." />
        <p className="small muted">
          The picture is from the live demo, whose agents run on our machine. To press STOP yourself,{" "}
          <a href={REPOSITORY} target="_blank" rel="noreferrer">
            run it from the repository
          </a>
          . Everything below is read from Arkiv by your browser, with no server of ours.
        </p>
        {view && (
          <div className="home-numbers">
            <div>
              <b>{String(view.block)}</b>
              latest block read
            </div>
            <div>
              <b>{view.recalls.length}</b>
              recalls on record
            </div>
            <div>
              <b>{view.acks.length}</b>
              public receipts
            </div>
            <div>
              <b>{view.agents.length}</b>
              agents on record
            </div>
          </div>
        )}
      </section>

      {error && !view && <div className="notice bad">Cannot read Arkiv right now: {error}</div>}
      {!view && !error && <div className="muted">Reading Arkiv…</div>}

      {view && (
        <>
          <NetworkMap view={view} />
          <RecallList view={view} />
          <div className="card">
            <h2>Agents on the record</h2>
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Responsible</th>
                  <th>Status</th>
                  <th>Tools it loaded</th>
                </tr>
              </thead>
              <tbody>
                {view.agents.map((a) => (
                  <tr key={a.agent.key}>
                    <td>
                      <a href={`#/agent/${a.agent.agent}`}>{a.agent.name}</a>
                    </td>
                    <td>{nameOf(a.agent.owner)}</td>
                    <td>
                      <span className={`status ${statusColour(a.heartbeat?.mode)}`}>{statusLabel(a.heartbeat?.mode)}</span>
                    </td>
                    <td>
                      {a.loadout?.files
                        .filter((f) => f.kind === "tool" || f.kind === "skill")
                        .map((f) => `${f.name} ${f.version}`)
                        .join(", ") ?? "Not published"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ marginBottom: 0 }}>
              "Unknown" means no live heartbeat, which is what an agent looks like when the demo is not running.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
