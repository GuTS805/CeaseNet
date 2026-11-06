import { RecallList } from "./RecallPages"
import { nameOf, statusColour, statusLabel, usePublicView } from "./lib"

const REPOSITORY = "https://github.com/GuTS805/CeaseNet"

/** The front page when no live agents can be reached from here. Everything on it comes straight from Arkiv. */
export function PublicHome() {
  const { data: view, error } = usePublicView()
  return (
    <div className="page" style={{ display: "grid", gap: 12 }}>
      <div className="card">
        <h1 style={{ marginBottom: 6 }}>Recalls for AI agents</h1>
        <p style={{ marginTop: 0 }}>
          When a tool an AI agent uses turns out to be malicious, taking it off the marketplace doesn't stop agents that already have it. CeaseNet is a public recall
          list on Arkiv that agents check for themselves. A STOP blocks that one tool within seconds, and each agent posts a public receipt.
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          This page reads Arkiv directly in your browser, with no server of ours. The demo's live agents run on our machine, so to press STOP yourself,{" "}
          <a href={REPOSITORY} target="_blank" rel="noreferrer">
            run it from the repository
          </a>
          .
        </p>
      </div>

      {error && !view && <div className="notice bad">Cannot read Arkiv right now: {error}</div>}
      {!view && !error && <div className="muted">Reading Arkiv…</div>}

      {view && (
        <>
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
