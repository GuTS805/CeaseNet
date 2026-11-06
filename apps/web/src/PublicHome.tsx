import { useMemo, useState } from "react"
import { onlyLive } from "@ceasenet/core"
import { RecallList } from "./RecallPages"
import { nameOf, statusColour, statusLabel, useNetworkView } from "./lib"
import { LiveToggle, NetworkMap } from "./NetworkPage"

const REPOSITORY = "https://github.com/GuTS805/CeaseNet"

const STEPS = [
  { command: "npm run install-cli", what: "From a clone of the repository. Installs one program, with nothing else to run." },
  { command: "ceasenet init", what: "Creates this agent's identity and yours as its owner. Add --local to start with no wallet, on this machine only." },
  { command: "ceasenet protect", what: "Puts a gate in front of every MCP server in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI. The tools and your agent stay as they are." },
  { command: "ceasenet console", what: "Watch every real tool call, and press Stop." },
]

/** The front page. The agents are yours and run on your machines. Everything listed below comes straight from Arkiv. */
export function PublicHome() {
  const { data: view, error } = useNetworkView()
  const [everyone, setEveryone] = useState(false)
  const shown = useMemo(() => view && (everyone ? view : onlyLive(view)), [view, everyone])
  return (
    <div className="page home">
      <section className="home-hero">
        <h1>Stop your AI agents, and recall the tools they use</h1>
        <p className="home-lead">
          CeaseNet sits between your agent and its MCP tools. Press Stop and the next call is refused, with the reason, and the tool's process is ended. Every call goes in a diary nobody can quietly change, and anyone can report a bad agent. It works from another machine, and it keeps working if we disappear, because each
          gate reads a public list on Arkiv by itself.
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
        <img className="home-shot" src="./console.png" alt="The CeaseNet console: three AI agents that closed themselves when a tool they use was recalled, each showing how long it took and that its process has ended." />

        <div className="card" style={{ marginTop: 16 }}>
          <h2>Start in a minute</h2>
          <table>
            <tbody>
              {STEPS.map((s) => (
                <tr key={s.command}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {s.command}
                  </td>
                  <td>{s.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Then restart your agent's client and use it as usual. Everything is in{" "}
            <a href={REPOSITORY} target="_blank" rel="noreferrer">
              the repository
            </a>
            , under the MIT licence.
          </p>
        </div>

        <p className="small muted">The public list is below, read from Arkiv by your browser with no server of ours. It runs on a test network for now.</p>
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

      {view && shown && (
        <>
          <LiveToggle view={view} everyone={everyone} onChange={setEveryone} />
          <NetworkMap view={view} shown={shown} />
          <RecallList view={view} />
          <p className="small muted">Anyone can publish a recall, so this shows all of them with who issued each one. A recall binds only the agents whose owners follow that key.</p>
          {shown.agents.length > 0 && (
            <div className="card">
              <h2>Agents that have registered in public</h2>
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
                  {shown.agents.map((a) => (
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
                "Unknown" means no live heartbeat. Nobody can tell from outside whether an agent is off or ignoring the list. Registering is optional, and an agent can obey the list while leaving no public trace.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
