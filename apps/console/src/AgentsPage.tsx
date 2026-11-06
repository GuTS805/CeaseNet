import { post, type TeamMember, type TeamState, type TeamTool, usePoll } from "./api"
import { type Ask, ago, Copyable, type Run, short, Status, Tile, type Tone, useNow } from "./ui"

const PHASE: Record<string, { label: string; tone: Tone }> = {
  starting: { label: "Reading the list", tone: "grey" },
  working: { label: "Working", tone: "green" },
  idle: { label: "Between jobs", tone: "green" },
  paused: { label: "Paused", tone: "amber" },
  waiting: { label: "Waiting", tone: "amber" },
  closing: { label: "Closing", tone: "red" },
  closed: { label: "Closed", tone: "red" },
  off: { label: "Shut down", tone: "grey" },
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

function describe(member: TeamMember): { label: string; tone: Tone } {
  const phase = member.state?.phase
  if (!phase) return { label: "Not started", tone: "grey" }
  // Whatever it last said about itself, the system knows whether the process is still there.
  if (!member.alive && phase !== "closed" && phase !== "off") return { label: "Ended unexpectedly", tone: "red" }
  return PHASE[phase] ?? { label: phase, tone: "grey" }
}

function ToolChip({ tool }: { tool: TeamTool }) {
  return (
    <span className={`chip ${tool.recall ? "chip-recalled" : ""}`} title={tool.recall ? `Recalled: ${tool.recall.reason}` : tool.spec}>
      {tool.recall && <span aria-hidden="true">■ </span>}
      {tool.label}
      {tool.recall && " (recalled)"}
    </span>
  )
}

function AgentCard({ member, tools, state, now, onAsk, run }: { member: TeamMember; tools: TeamTool[]; state: TeamState; now: number; onAsk: (ask: Ask) => void; run: Run }) {
  const status = describe(member)
  const s = member.state
  const closed = s?.phase === "closed" || s?.phase === "closing"
  const mine = tools.filter((t) => member.tools.includes(t.id))
  const check = s?.lastCheck

  const stop = () =>
    onAsk({
      title: `Stop ${member.name}`,
      body: <p>Only this agent closes. The others keep working. It reads the list, sees this, ends its job and leaves.</p>,
      confirm: "Stop this agent",
      danger: true,
      needsReason: true,
      placeholder: "It is doing something nobody asked for",
      go: ({ reason }) => post("/api/kill", { agent: member.address, reason }),
    })

  return (
    <article className={`agent ${closed ? "agent-closed" : ""}`} aria-label={member.name}>
      <header className="agent-head">
        <Status tone={status.tone}>{status.label}</Status>
        <span className="muted small nowrap">{member.alive && s ? `Process ${s.pid}` : s && closed ? "Process ended" : ""}</span>
      </header>
      <h3>{member.name}</h3>
      <p className="muted small agent-does">{member.does}</p>

      {closed && s?.closed ? (
        <div className="closed-box">
          <div className="closed-title">{s.closed.afterStart ? "It closed itself" : "It refused to start"}</div>
          <div>{s.closed.tool ? `${s.closed.tool} was recalled: ${s.closed.reason}` : s.closed.reason}</div>
          <ul className="proof">
            {member.closedAfterMs !== undefined && <li>Closed {seconds(member.closedAfterMs)} after you pressed Stop</li>}
            <li>{member.alive ? `Process ${s.pid} is still ending` : `Process ${s.pid} has ended, confirmed by the system`}</li>
            <li>{member.guards.length === 0 ? "Its tools' processes have ended too" : `${member.guards.length} of its tools still ending`}</li>
            <li>{member.receiptPosted ? "Its receipt is on the list" : "Its receipt is on its way"}</li>
          </ul>
          <div className="agent-actions">
            {member.recallEnded === false && member.recallMine ? (
              <button onClick={() => void run(() => post("/api/lift", { recall: s.closed!.recall, note: "Lifted from the console" }))}>Lift this recall</button>
            ) : (
              <button onClick={() => void run(() => post("/api/team/start", { ids: [member.id] }))} disabled={Boolean(state.preparing)}>
                Start it again
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <dl className="facts">
            <dt>Recall list</dt>
            <dd>
              {check ? (
                <>
                  Checked {ago(check.at, now)}
                  {state.network === "arkiv" ? `, block ${check.block}` : ""}, in {check.tookMs} ms
                  {!check.online && <span className="amber-text"> (could not read it)</span>}
                  <div className="muted small">
                    {s!.checks} checks so far. Nothing covers this agent.
                  </div>
                </>
              ) : (
                <span className="muted">Not read yet</span>
              )}
            </dd>
            <dt>Tools</dt>
            <dd className="chips">
              {mine.map((t) => (
                <ToolChip key={t.id} tool={t} />
              ))}
            </dd>
            <dt>Doing</dt>
            <dd>{s?.job ?? <span className="muted">{s?.phase === "paused" ? "Nothing: nobody is watching, so it saves your model allowance" : "Nothing right now"}</span>}</dd>
            <dt>Done</dt>
            <dd>
              {s?.jobs ?? 0} {s?.jobs === 1 ? "job" : "jobs"}, {member.resultCount} {member.resultCount === 1 ? "file" : "files"}, {member.calls.length} tool {member.calls.length === 1 ? "call" : "calls"}
            </dd>
          </dl>
          {s?.problem && <div className="agent-problem">{s.problem}</div>}
          {s?.lastSaid && <blockquote className="said">{s.lastSaid}</blockquote>}
          {member.results[0] && (
            <details className="result">
              <summary>
                Latest work: {member.results[0].name}, {ago(member.results[0].at, now)}
              </summary>
              <pre>{member.results[0].preview}</pre>
            </details>
          )}
          {member.alive && (
            <div className="agent-actions">
              <button className="danger-quiet" disabled={!state.canSign} onClick={stop}>
                Stop this agent
              </button>
            </div>
          )}
        </>
      )}
    </article>
  )
}

function Timeline({ members, now }: { members: TeamMember[]; now: number }) {
  const rows = members
    .flatMap((m) => [
      ...m.events.map((e) => ({ at: e.at, who: m.name, kind: e.kind as string, text: e.text, tone: (e.kind === "closed" ? "red" : e.kind === "problem" || e.kind === "paused" ? "amber" : e.kind === "said" ? "green" : "grey") as Tone, label: e.kind === "closed" ? "Closed" : e.kind === "said" ? "Model said" : e.kind === "job" ? "Job" : e.kind === "started" ? "Started" : e.kind === "paused" ? "Paused" : "Problem" })),
      ...m.calls.map((c) => ({ at: c.at, who: m.name, kind: "call", text: c.allowed ? `${c.action} on ${c.tool}, in ${c.gateMs} ms` : `${c.action} on ${c.tool}: ${c.message}`, tone: (c.allowed ? "green" : "red") as Tone, label: c.allowed ? "Gate allowed" : "Gate refused" })),
    ])
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)
  return (
    <section className="panel">
      <header>
        <h2>What they are doing</h2>
        <span className="muted small">Every line is something that really happened</span>
      </header>
      {rows.length === 0 ? (
        <div className="empty">
          <p>Nothing yet. Start them, and each job, tool call and check that matters appears here.</p>
        </div>
      ) : (
        <table className="calls">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.at}-${i}`}>
                <td className="muted small nowrap">{ago(r.at, now)}</td>
                <td className="small nowrap">{r.who}</td>
                <td className="nowrap">
                  <Status tone={r.tone} small>
                    {r.label}
                  </Status>
                </td>
                <td className="small why">{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function AgentsPage({ onAsk, run }: { onAsk: (ask: Ask) => void; run: Run }) {
  const { data: team, error, refresh } = usePoll<TeamState>("/api/team", 1000)
  const now = useNow()
  if (!team) return <div className="loading">{error ?? "Loading…"}</div>

  const act: Run = async (work) => {
    const ok = await run(work)
    await refresh()
    return ok
  }

  const members = team.members
  const alive = members.filter((m) => m.alive).length
  const anyStarted = members.some((m) => m.state)
  const totalCalls = members.reduce((n, m) => n + m.calls.length, 0)
  const refused = members.reduce((n, m) => n + m.calls.filter((c) => !c.allowed).length, 0)
  const jobs = members.reduce((n, m) => n + (m.state?.jobs ?? 0), 0)
  const canStart = !team.preparing && alive < members.length && Boolean(team.thinking)

  const stopAll = () =>
    onAsk({
      title: "Stop all three agents",
      body: <p>This goes on the list. Each agent reads it, ends its job and closes itself. Nothing else you run is affected.</p>,
      confirm: "Stop all three",
      danger: true,
      needsReason: true,
      placeholder: "Something is wrong, and I want them all to stop",
      go: ({ reason }) => post("/api/team/stop", { reason }),
    })

  const recallTool = (tool: TeamTool) =>
    onAsk({
      title: `Recall ${tool.label}`,
      body: (
        <p>
          {tool.usedBy.length === members.length ? "All three agents use it, so all three will close." : `${tool.usedBy.join(" and ")} use it, so they will close, and the others keep working.`} Anything else of yours using this tool stops being able to as well.
        </p>
      ),
      confirm: "Recall this tool",
      danger: true,
      needsReason: true,
      placeholder: "It reads files it should not",
      go: ({ reason }) => post("/api/stop", { hash: tool.file.hash, name: tool.file.name, versions: tool.file.version, reason, severity: "CRITICAL" }),
    })

  const thinkingText =
    team.thinking?.kind === "api"
      ? `${team.thinking.model} on ${team.thinking.host}, which spends your key's limit`
      : team.thinking?.kind === "claude"
        ? `Claude Code with the ${team.thinking.model} model, which spends your Claude plan`
        : "nothing yet"

  return (
    <div className="page-body">
      <div className="page-title">
        <div>
          <h1>Three AI agents</h1>
          <p className="muted">
            Each is its own process, thinking with {thinkingText}. Each does real work through real MCP tools, and keeps reading the recall list. When a recall covers it, it closes itself and its process ends. No one has to tell it twice, and the model is not asked.
          </p>
        </div>
        <div className="page-actions">
          {team.preparing && <span className="muted small">{team.preparing}…</span>}
          <button className="primary" disabled={!canStart} onClick={() => void act(() => post("/api/team/start"))}>
            {team.preparing ? "Starting…" : anyStarted ? "Start any that are off" : "Start the agents"}
          </button>
          <button disabled={alive === 0} onClick={() => void act(() => post("/api/team/shutdown"))} title={alive === 0 ? "Nothing is running" : "Ends them with no recall, to put this away"}>
            Shut down
          </button>
          {team.teamRecall ? (
            <button onClick={() => void act(() => post("/api/lift", { recall: team.teamRecall!.key, note: "Lifted from the console" }))}>Lift the stop</button>
          ) : (
            <button className="danger" disabled={alive === 0 || !team.canSign} title={alive === 0 ? "Nothing is running" : !team.canSign ? "The owner's key is on another machine" : undefined} onClick={stopAll}>
              Stop all three
            </button>
          )}
        </div>
      </div>

      {alive === 0 && !team.preparing && <p className="small muted">Nothing is running, so Shut down and Stop all three are greyed out. Start the agents first.</p>}

      {team.choices.length > 0 && (
        <label className="thinking">
          They think with
          <select value={team.choice ?? ""} disabled={Boolean(team.preparing)} onChange={(e) => void act(() => post("/api/team/thinking", { choice: e.target.value }))}>
            {team.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="muted small">Trying a model first costs a few tokens. Those running move to it straight away.</span>
        </label>
      )}

      {!team.thinking && (
        <div className="notice">
          They need a model to think with. Run <code>ceasenet import-settings path\to\.env</code> with a MODEL_API_KEY in it, or install Claude Code and log in.
        </div>
      )}
      {team.startError && <div className="notice bad">{team.startError}</div>}

      <div className="tiles">
        <Tile label="Agents running" value={`${alive} of ${members.length}`} note={alive === 0 && anyStarted ? "None are running" : undefined} />
        <Tile label="Jobs finished" value={jobs} />
        <Tile label="Tool calls through the gate" value={totalCalls} note="The latest 30 for each agent" />
        <Tile label="Calls refused" value={refused} />
      </div>

      <div className="agents">
        {members.map((m) => (
          <AgentCard key={m.id} member={m} tools={team.tools} state={team} now={now} onAsk={onAsk} run={act} />
        ))}
      </div>

      <section className="panel">
        <header>
          <h2>Recall a tool</h2>
          <span className="muted small">Every agent using it closes at its next check</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Exact file</th>
              <th>Used by</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {team.tools.map((t) => (
              <tr key={t.id} className={t.recall ? "row-blocked" : ""}>
                <td>
                  <div className="tool-name">{t.label}</div>
                  <div className="muted small">
                    {t.file.name}
                    {t.file.version ? ` ${t.file.version}` : ""}
                  </div>
                </td>
                <td className="small">{t.file.hash ? <Copyable value={t.file.hash} /> : <span className="muted">Not installed yet</span>}</td>
                <td className="small">{t.usedBy.map((n) => n.replace(" agent", "")).join(", ")}</td>
                <td>
                  {t.recall ? <Status tone="red">Recalled</Status> : <Status tone="green">Allowed</Status>}
                  {t.recall && <div className="tool-why">{t.recall.reason}</div>}
                </td>
                <td className="actions">
                  {t.recall ? (
                    t.recall.mine ? (
                      <button onClick={() => void act(() => post("/api/lift", { recall: t.recall!.key, note: "Lifted from the console" }))}>Lift</button>
                    ) : (
                      <span className="muted small">Issued by someone else</span>
                    )
                  ) : (
                    <button className="danger-quiet" disabled={!t.file.hash || !team.canSign} onClick={() => recallTool(t)}>
                      Recall
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Timeline members={members} now={now} />

      <p className="muted small foot-note">
        The tasks are sample files in each agent's own folder, which is all its tools can reach. They pause after 2 minutes with nobody looking at this console, and shut down after 15, so they cannot run up your model limit unattended.
        {members[0]?.address ? ` Agent keys: ${members.map((m) => short(m.address ?? "")).join(", ")}.` : ""}
      </p>
    </div>
  )
}
