import { useState } from "react"
import { type Approval, type Call, type ClientReport, type FleetAgent, post, type Recall, type State, type Tool } from "./api"
import { ago, type Ask, Copyable, type Run, short } from "./ui"

const FAUCET = "https://hub.arkiv.network/faucet"

function Hero({ state, onAsk, run }: { state: State; onAsk: (ask: Ask) => void; run: Run }) {
  const stopped = state.agent.status === "STOPPED"
  const running = state.tools.length
  const blocked = state.tools.filter((t) => t.mode === "BLOCK").length
  const canSign = state.owner.canSign

  const askStop = () =>
    onAsk({
      title: "Stop this agent",
      body: (
        <p>
          Every MCP tool call will be refused and those tools' processes ended{state.claudeCode.covered ? ", and Claude Code's own tools such as Bash will be refused too" : ""}. A session already open can still reply, but it can no longer act. You can restart it from here.
        </p>
      ),
      confirm: "Stop",
      danger: true,
      needsReason: true,
      placeholder: "It is deleting files it should not touch",
      options: [
        { value: "agent", label: `Only ${state.agent.name}`, hint: "The agent on this machine." },
        { value: "fleet", label: "All my agents", hint: "Every agent that answers to this owner, on any machine." },
      ],
      go: ({ reason, option }) => post("/api/kill", option === "fleet" ? { all: true, reason } : { agent: state.agent.address, reason }),
    })

  return (
    <section className={`hero ${stopped ? "stopped" : ""}`}>
      <div>
        <div className="hero-state">
          <span className={`dot ${stopped ? "red" : blocked ? "amber" : "green"}`} />
          {stopped ? "Stopped" : "Running"}
        </div>
        <h1>{state.agent.name}</h1>
        <p className="hero-line">
          {stopped
            ? state.stoppedBy
              ? `Every tool call is being refused. ${state.stoppedBy.reason}`
              : "Every tool call is being refused."
            : running === 0
              ? "No tools are connected yet."
              : blocked > 0
                ? `${running - blocked} of ${running} tools can be used. ${blocked} ${blocked === 1 ? "is" : "are"} blocked.`
                : `${running} ${running === 1 ? "tool" : "tools"} connected, and calls are going through.`}
        </p>
      </div>
      <div className="hero-actions">
        {stopped && state.stoppedBy ? (
          <button
            className="primary big"
            disabled={!canSign}
            onClick={() => void run(() => post("/api/lift", { recall: state.stoppedBy!.key, note: "Restarted from the console" }))}
          >
            Restart agent
          </button>
        ) : (
          <button className="danger big" disabled={!canSign || stopped} onClick={askStop}>
            Stop agent
          </button>
        )}
        {!canSign && <small>The owner's key is on another machine, so stop it from there.</small>}
      </div>
    </section>
  )
}

const MODE_LABEL: Record<Tool["mode"], string> = { ALLOW: "Allowed", NEEDS_APPROVAL: "Asks a person", BLOCK: "Blocked" }
const MODE_COLOUR: Record<Tool["mode"], string> = { ALLOW: "green", NEEDS_APPROVAL: "amber", BLOCK: "red" }
const STRENGTH: Record<Tool["strength"], { label: string; hint: string }> = {
  pinned: { label: "Pinned", hint: "This exact version was installed here, and its files were measured. What runs is what was measured." },
  measured: { label: "Measured", hint: "Its files on disk were measured when it started." },
  command: { label: "By command only", hint: "Its files cannot be seen, as with Docker or a Python runner. It is known only by how it is started." },
}

function ToolRow({ tool, state, now, onAsk, run }: { tool: Tool; state: State; now: number; onAsk: (ask: Ask) => void; run: Run }) {
  const stopTool = () =>
    onAsk({
      title: `Stop ${tool.name}`,
      body: <p>Calls to it will be refused and its process ended, on every agent that obeys you. The agent keeps its other tools.</p>,
      confirm: "Stop tool",
      danger: true,
      needsReason: true,
      withAdvice: true,
      placeholder: "It is sending data somewhere it should not",
      options:
        tool.strength === "command"
          ? [{ value: "all", label: "This tool", hint: `Anything named ${tool.name}, and this exact command.` }]
          : [
              { value: "version", label: `Version ${tool.version}`, hint: "Others keep working, so you can move to a safe version." },
              { value: "all", label: "Every version", hint: `Anything named ${tool.name}.` },
            ],
      go: ({ reason, option, advice }) =>
        post("/api/stop", { hash: tool.hash, name: tool.name, versions: option === "version" ? tool.version : "*", reason, advice: advice || undefined, severity: "HIGH" }),
    })

  const recall = state.recalls?.find((r) => r.key === tool.recall?.key)
  const stoppedWithAgent = recall?.kill || tool.recall?.artifact.startsWith("agent:") || tool.recall?.artifact.startsWith("fleet:")
  const processText = tool.toolPids.length ? `Process ${tool.toolPids.join(", ")}` : tool.recall || tool.blockedLocally ? "Process ended" : "Not running"

  return (
    <tr className={tool.mode === "BLOCK" ? "row-blocked" : ""}>
      <td>
        <div className="tool-name">{tool.name}</div>
        <div className="muted small">
          {tool.strength === "command" ? "version unknown" : `v${tool.version}`} ·{" "}
          <span title={STRENGTH[tool.strength].hint} className="hint">
            {STRENGTH[tool.strength].label}
          </span>{" "}
          · <Copyable value={tool.hash} />
        </div>
        {tool.recall && <div className="tool-why">{tool.recall.reason}</div>}
        {tool.blockedLocally && <div className="tool-why">{tool.blockedLocally}</div>}
        {!tool.online && !tool.recall && <div className="tool-why amber-text">Cannot read the recall list. It runs for a grace period, then asks a person, then refuses.</div>}
      </td>
      <td>
        <span className={`pill ${MODE_COLOUR[tool.mode]}`}>{MODE_LABEL[tool.mode]}</span>
        <div className="muted small nowrap">{processText}</div>
      </td>
      <td className="nowrap">
        {tool.calls} {tool.calls === 1 ? "call" : "calls"}
        {tool.refused > 0 && <span className="red-text"> · {tool.refused} refused</span>}
        <div className="muted small">{ago(tool.lastCallAt, now)}</div>
      </td>
      <td className="actions">
        {stoppedWithAgent ? (
          <span className="muted small">Stopped with the agent</span>
        ) : tool.recall ? (
          recall?.mine ? (
            <button onClick={() => void run(() => post("/api/lift", { recall: tool.recall!.key, note: "Lifted from the console" }))}>Lift</button>
          ) : (
            <span className="muted small">Issued by {short(tool.recall.issuer)}</span>
          )
        ) : (
          <>
            <label className="toggle" title="Each call waits for you to approve it here">
              <input type="checkbox" checked={tool.held} onChange={(e) => void run(() => post("/api/hold", { tool: tool.name, hold: e.target.checked }))} />
              Ask me first
            </label>
            <button className="danger-quiet" disabled={!state.owner.canSign} onClick={stopTool}>
              Stop
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

function Tools({ state, now, onAsk, run }: { state: State; now: number; onAsk: (ask: Ask) => void; run: Run }) {
  return (
    <section className="panel">
      <header>
        <h2>Tools</h2>
        <span className="muted small">{state.guardsRunning} guarded {state.guardsRunning === 1 ? "connection" : "connections"}</span>
      </header>
      {state.tools.length === 0 ? (
        <div className="empty">
          <p>Nothing is connected right now. Tools appear here when your agent's client starts them.</p>
          <p className="muted small">
            If you have run <code>ceasenet protect</code>, restart your client. Then use it as usual.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>State</th>
              <th>Use</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.tools.map((t) => (
              <ToolRow key={t.hash} tool={t} state={state} now={now} onAsk={onAsk} run={run} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Approvals({ approvals, now, run }: { approvals: Approval[]; now: number; run: Run }) {
  if (approvals.length === 0) return null
  return (
    <section className="approvals">
      {approvals.map((a) => (
        <div key={a.id} className="approval">
          <div className="approval-main">
            <div className="approval-title">
              <b>{a.tool}</b> wants to run <b className="mono">{a.action}</b>
            </div>
            <div className="muted small">{a.reason}</div>
            {a.details && <pre>{a.details}</pre>}
          </div>
          <div className="approval-side">
            <div className="muted small nowrap">{Math.max(0, Math.round((a.expiresAt - now) / 1000))}s left</div>
            <button className="primary" onClick={() => void run(() => post(`/api/approvals/${a.id}`, { approve: true }))}>
              Approve
            </button>
            <button onClick={() => void run(() => post(`/api/approvals/${a.id}`, { approve: false }))}>Refuse</button>
          </div>
        </div>
      ))}
    </section>
  )
}

function callResult(c: Call): { text: string; colour: string } {
  if (c.allowed) return c.approval === "APPROVED" ? { text: "Approved", colour: "green" } : { text: "Allowed", colour: "green" }
  if (c.approval === "DENIED") return { text: "You refused", colour: "red" }
  if (c.approval === "EXPIRED") return { text: "Nobody approved", colour: "amber" }
  return { text: "Refused", colour: "red" }
}

function Activity({ calls, now }: { calls: Call[]; now: number }) {
  return (
    <section className="panel">
      <header>
        <h2>Calls</h2>
        <a className="small" href="#/diary">See the full record in the diary</a>
      </header>
      {calls.length === 0 ? (
        <div className="empty">
          <p>No calls yet.</p>
        </div>
      ) : (
        <table className="calls">
          <tbody>
            {calls.map((c, i) => {
              const result = callResult(c)
              return (
                <tr key={`${c.at}-${i}`}>
                  <td className="muted small nowrap">{ago(c.at, now)}</td>
                  <td>
                    <span className="mono">{c.action}</span> <span className="muted small">{c.tool}</span>
                    {c.message && <div className="muted small why">{c.message}</div>}
                  </td>
                  <td className="nowrap">
                    <span className={`pill small-pill ${result.colour}`}>{result.text}</span>
                  </td>
                  <td className="muted small nowrap right" title="How long the gate took to decide">
                    {c.gateMs} ms
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Recalls({ recalls, block, run, canSign }: { recalls?: Recall[]; block?: string; run: Run; canSign: boolean }) {
  const [showEnded, setShowEnded] = useState(false)
  const active = (recalls ?? []).filter((r) => !r.ended)
  const ended = (recalls ?? []).filter((r) => r.ended)
  const shown = showEnded ? [...active, ...ended] : active
  return (
    <section className="panel">
      <header>
        <h2>Recalls</h2>
        {block && <span className="muted small mono">block {block}</span>}
      </header>
      {recalls === undefined ? (
        <div className="empty muted">Reading…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <p>Nothing is recalled by anyone you obey.</p>
        </div>
      ) : (
        <ul className="recalls">
          {shown.map((r) => (
            <li key={r.key} className={r.ended ? "ended" : ""}>
              <div className="recall-head">
                <span className={`pill small-pill ${r.ended ? "grey" : r.level === "STOP" ? "red" : "amber"}`}>{r.ended ? "Ended" : r.level === "STOP" ? "STOP" : "Warning"}</span>
                <b>{r.target}</b>
                {r.pkg && r.versions && r.versions !== "*" && <span className="muted small">{r.versions}</span>}
              </div>
              <div>{r.reason}</div>
              {r.advice && <div className="muted small">What to do: {r.advice}</div>}
              <div className="muted small recall-foot">
                <span>{r.mine ? "Issued by you" : `Issued by ${short(r.creator)}`}</span>
                <span>
                  {r.receipts} {r.receipts === 1 ? "receipt" : "receipts"}
                </span>
                {r.mine && !r.ended && canSign && (
                  <button className="link" onClick={() => void run(() => post("/api/lift", { recall: r.key, note: "Lifted from the console" }))}>
                    Lift
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {ended.length > 0 && (
        <button className="link pad" onClick={() => setShowEnded(!showEnded)}>
          {showEnded ? "Hide ended recalls" : `Show ${ended.length} ended`}
        </button>
      )}
    </section>
  )
}

function Trust({ state }: { state: State; run: Run }) {
  return (
    <section className="panel">
      <header>
        <h2>Whom your agents obey</h2>
      </header>
      <div className="pad-body">
        <p className="muted small">Only you. A STOP from any other key is ignored. Anyone can open a recall on your agents on the website, and others vote. At enough votes it shows up under Reports, and you decide.</p>
        <ul className="plain">
          <li>
            <Copyable value={state.owner.address} /> <span className="muted small">You, the owner</span>
          </li>
        </ul>
      </div>
    </section>
  )
}

function Fleet({ fleet, state, onAsk, run }: { fleet?: FleetAgent[]; state: State; onAsk: (ask: Ask) => void; run: Run }) {
  const [address, setAddress] = useState("")
  const [name, setName] = useState("")
  const others = (fleet ?? []).filter((a) => a.agent.toLowerCase() !== state.agent.address.toLowerCase())
  const enroll = async (event: React.FormEvent) => {
    event.preventDefault()
    if (await run(() => post("/api/enroll", { agent: address.trim(), name: name.trim() || "Agent" }))) {
      setAddress("")
      setName("")
    }
  }
  const statusText = (status?: string) => (status === "RUNNING" ? "Running" : status === "STOPPED" ? "Stopped" : status === "SUPERVISED" ? "Asks a person" : "Silent")
  return (
    <section className="panel">
      <header>
        <h2>Your other agents</h2>
      </header>
      <div className="pad-body">
        {others.length === 0 ? (
          <p className="muted small">
            None yet. On another machine, run <code>ceasenet init --owner {short(state.owner.address)}</code>, and add its agent's address here to stop it from this console.
          </p>
        ) : (
          <ul className="plain">
            {others.map((a) => (
              <li key={a.agent}>
                <span>
                  <b>{a.name}</b> <span className="muted small">{statusText(a.status)}</span>
                  <div className="muted small">{a.tools.map((t) => t.name).join(", ") || "No tools published"}</div>
                </span>
                <button
                  className="danger-quiet"
                  disabled={!state.owner.canSign}
                  onClick={() =>
                    onAsk({
                      title: `Stop ${a.name}`,
                      body: <p>It will refuse every tool from its next check, wherever it is running.</p>,
                      confirm: "Stop",
                      danger: true,
                      needsReason: true,
                      go: ({ reason }) => post("/api/kill", { agent: a.agent, reason }),
                    })
                  }
                >
                  Stop
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.owner.canSign && (
          <form className="inline" onSubmit={(e) => void enroll(e)}>
            <input value={address} placeholder="0x… its agent address" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
            <input className="narrow" value={name} placeholder="Name" onChange={(e) => setName(e.target.value)} />
            <button type="submit" disabled={!address.trim()}>
              Add
            </button>
          </form>
        )}
      </div>
    </section>
  )
}

/** Only what still needs doing. Once everything is done, this is not on the page. */
function Setup({ state }: { state: State }) {
  const unprotected = state.clients.filter((c: ClientReport) => c.unprotected.length > 0)
  const remote = state.clients.flatMap((c) => c.remote)
  const needsFunds = state.network === "arkiv" && state.funds?.ownerEmpty && state.owner.canSign
  // An owner elsewhere funds this agent separately. With the owner here, its wallet is kept in funds automatically.
  const agentNeedsFunds = state.network === "arkiv" && state.funds?.agentEmpty && !state.owner.canSign
  const builtInsOpen = state.claudeCode.present && !state.claudeCode.covered
  if (!needsFunds && !agentNeedsFunds && !builtInsOpen && unprotected.length === 0 && remote.length === 0) return null
  return (
    <section className="setup">
      {needsFunds && (
        <div className="setup-item">
          <b>Fund your owner wallet to issue recalls and post receipts.</b> Your agents are already protected and obey the list, and reading it is free. Stopping things yourself costs a little test money.{" "}
          <Copyable value={state.owner.address} label={`Copy ${short(state.owner.address)}`} />{" "}
          <a href={FAUCET} target="_blank" rel="noreferrer">
            Open the faucet
          </a>
        </div>
      )}
      {agentNeedsFunds && (
        <div className="setup-item">
          <b>Fund this agent's wallet to post receipts.</b> It obeys its owner without this, but nobody can see that it did.{" "}
          <Copyable value={state.agent.address} label={`Copy ${short(state.agent.address)}`} />{" "}
          <a href={FAUCET} target="_blank" rel="noreferrer">
            Open the faucet
          </a>
        </div>
      )}
      {builtInsOpen && (
        <div className="setup-item">
          <b>Stopping this agent would not stop Claude Code's own tools.</b> Bash and file edits do not pass through MCP. Run <code>ceasenet protect</code> to cover them, then restart it.
        </div>
      )}
      {unprotected.map((c) => (
        <div className="setup-item" key={c.path}>
          <b>{c.client} has servers with no gate:</b> {c.unprotected.join(", ")}. An agent can use those with nothing checking them. Run <code>ceasenet protect</code>, then restart it.
        </div>
      ))}
      {remote.length > 0 && (
        <div className="setup-item">
          <b>Not covered:</b> {remote.join(", ")}. {remote.length === 1 ? "It is a remote server" : "They are remote servers"}, and the gate only sits in front of servers started on this machine.
        </div>
      )}
    </section>
  )
}

function Footer({ state }: { state: State }) {
  return (
    <footer className="foot muted small">
      <span>
        Agent <Copyable value={state.agent.address} />
      </span>
      <span>
        Owner <Copyable value={state.owner.address} />
      </span>
      {state.funds && (
        <span>
          Funds: owner {state.funds.owner} tGLM, agent {state.funds.agent} tGLM
        </span>
      )}
    </footer>
  )
}


/** This machine's own agent: your MCP clients, with the gate in front of them. */
export function MachinePage({ state, now, onAsk, run }: { state: State; now: number; onAsk: (ask: Ask) => void; run: Run }) {
  return (
    <div className="page-body">
      {state.problems.map((p) => (
        <div className="notice" key={p}>
          {p}
        </div>
      ))}
      <Hero state={state} onAsk={onAsk} run={run} />
      <Approvals approvals={state.approvals} now={now} run={run} />
      <Setup state={state} />
      <div className="columns">
        <div className="column-main">
          <Tools state={state} now={now} onAsk={onAsk} run={run} />
          <Activity calls={state.calls} now={now} />
        </div>
        <div className="column-side">
          <Recalls recalls={state.recalls} block={state.network === "arkiv" ? state.block : undefined} run={run} canSign={state.owner.canSign} />
          <Trust state={state} run={run} />
          <Fleet fleet={state.fleet} state={state} onAsk={onAsk} run={run} />
        </div>
      </div>
      <Footer state={state} />
    </div>
  )
}
