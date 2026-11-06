import { useEffect, useMemo, useState } from "react"
import { ADDRESSES, countConfirmations, demoPolicy, type RecallRow, trustFromPolicy } from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { WorldConfirm } from "./WorldConfirm"
import {
  type CallVerdict,
  type DemoAgent,
  demoGet,
  demoPost,
  type DemoState,
  type FeedItem,
  shortHash,
  statusColour,
  statusLabel,
  usePoll,
  usePublicView,
} from "./lib"

const trust = trustFromPolicy(demoPolicy())
const lower = (a: string) => a.toLowerCase()

const VERDICT: Record<CallVerdict, { label: string; colour: string }> = {
  ALLOW: { label: "Allowed", colour: "green" },
  NEEDS_APPROVAL: { label: "Needs a human", colour: "amber" },
  BLOCK: { label: "Blocked", colour: "red" },
}

const FEED_MARK: Record<FeedItem["kind"], string> = {
  job: "›",
  allowed: "✓",
  blocked: "✕",
  approved: "✓",
  refused: "✕",
  said: "“",
  problem: "!",
  update: "↑",
}

function Feed({ items }: { items: FeedItem[] }) {
  return (
    <div className="feed">
      {[...items].reverse().map((f) => (
        <div key={f.id} className={`feed-line ${f.kind}`} title={f.requestId ? `Model request ${f.requestId}` : undefined}>
          <span className="mark">{FEED_MARK[f.kind]}</span>
          <span>{f.text}</span>
        </div>
      ))}
      {items.length === 0 && <div className="muted small">Starting…</div>}
    </div>
  )
}

function Countdown({ until }: { until: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  return <>{Math.max(0, Math.ceil((until - Date.now()) / 1000))} s</>
}

function AgentCard({ agent, busy, act, canUpdate }: { agent: DemoAgent; busy: boolean; act: Act; canUpdate: boolean }) {
  return (
    <div className={`card agent ${agent.stolen > 0 && agent.tools.some((t) => t.file.version === "1.0.16" && t.verdict === "ALLOW") ? "leaking" : ""}`}>
      <div className="row between">
        <a className="agent-name" href={`#/agent/${agent.address}`}>
          {agent.company}
        </a>
        <span className={`status ${statusColour(agent.status)}`}>{statusLabel(agent.status)}</span>
      </div>

      <div className="tools">
        {agent.tools.map((t) => (
          <div className="tool" key={t.file.hash}>
            <span>
              {t.file.name} <span className="muted">{t.file.version}</span>
            </span>
            <span className={`status ${VERDICT[t.verdict].colour}`}>{VERDICT[t.verdict].label}</span>
          </div>
        ))}
      </div>

      <div className="stats">
        <div>
          <div className="stat">{agent.sent}</div>
          <div className="muted small">sent</div>
        </div>
        <div>
          <div className={`stat ${agent.stolen > 0 ? "bad" : ""}`}>{agent.stolen}</div>
          <div className="muted small">stolen</div>
        </div>
        <div>
          <div className="stat">{agent.drafts}</div>
          <div className="muted small">drafts</div>
        </div>
      </div>

      {agent.approval && (
        <div className="notice approval">
          <strong>
            {agent.approval.action} on {agent.approval.tool} {agent.approval.version} needs a human
          </strong>
          <div className="small muted">
            Answer within <Countdown until={agent.approval.expiresAt} />, or it is refused.
          </div>
          <div className="buttons" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void act("Approve", `/api/agents/${agent.id}/approval`, { approve: true })}>
              Approve
            </button>
            <button onClick={() => void act("Refuse", `/api/agents/${agent.id}/approval`, { approve: false })}>Refuse</button>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            Stand-in buttons until World ID Agent Pass is connected.
          </div>
        </div>
      )}

      <Feed items={agent.feed} />

      <div className="buttons">
        <button disabled={busy} onClick={() => void act("Connection", `/api/agents/${agent.id}/network`, { up: !agent.online })}>
          {agent.online ? "Cut connection" : "Restore connection"}
        </button>
        {agent.followsMaker !== undefined && (
          <button disabled={busy} onClick={() => void act("Trust list", `/api/owners/${agent.id}/follow-maker`, { follow: !agent.followsMaker })}>
            {agent.followsMaker ? "Stop following maker" : "Follow maker"}
          </button>
        )}
        {canUpdate && (
          <button className="primary" disabled={busy} onClick={() => void act("Update", `/api/agents/${agent.id}/update`)}>
            Install fix
          </button>
        )}
      </div>
    </div>
  )
}

type Act = (name: string, path: string, body?: unknown) => Promise<unknown>

/** The demo screen: what each company's agent is doing, and the public record that controls it. */
export function LivePage() {
  const { data: state, error: demoError } = usePoll<DemoState>(() => demoGet<DemoState>("/api/state"), 1000)
  const { data: view, error } = usePublicView()
  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [timer, setTimer] = useState<{ start: number; end?: number }>()
  const [, tick] = useState(0)
  const [humans, setHumans] = useState(0)
  const [evidence, setEvidence] = useState<string>()

  const badHash = state?.tools.bad.hash
  const recalls = useMemo(
    () => (view && badHash ? view.recalls.filter((r) => lower(r.artifact) === lower(badHash)) : []),
    [view, badHash],
  )
  const stop = recalls.find((r) => r.level === "STOP" && lower(r.creator) === lower(ADDRESSES.maker))
  const stopLifts = stop ? view?.lifts.filter((l) => l.recall === stop.key) : undefined
  const hasFix = stopLifts?.some((l) => l.kind === "FIX")
  const warning = recalls.find(
    (r) => r.level === "ADVISORY" && !view?.lifts.some((l) => l.recall === r.key && l.kind === "DISMISSED"),
  )
  const focus: RecallRow | undefined = stop ?? warning
  const counts = warning && view ? countConfirmations(warning, view.endorsements, view.block, trust) : undefined
  const fixOnSwarm = stopLifts?.find((l) => l.kind === "FIX")?.fixedRef
  const disclosed = stop ? view?.disclosures.some((d) => d.recall === stop.key) : false

  const agents = state?.agents ?? []
  const stolen = agents.reduce((sum, a) => sum + a.stolen, 0)
  const sent = agents.reduce((sum, a) => sum + a.sent, 0)
  const stillLeaking = agents.filter((a) => a.tools.some((t) => t.file.version === "1.0.16" && t.verdict !== "BLOCK"))

  // The timer runs from pressing STOP until every online agent that follows the maker has blocked the tool.
  useEffect(() => {
    if (!timer || timer.end) return
    const followers = agents.filter((a) => a.online && a.followsMaker !== false)
    const done = followers.length > 0 && followers.every((a) => a.tools.some((t) => t.file.version === "1.0.16" && t.verdict === "BLOCK"))
    if (done) setTimer({ ...timer, end: Date.now() })
    const id = setTimeout(() => tick((n) => n + 1), 50)
    return () => clearTimeout(id)
  })

  const act: Act = async (name, path, body = {}) => {
    setBusy(name)
    setProblem(undefined)
    try {
      return await demoPost(path, body)
    } catch (e) {
      setProblem(`${name}: ${(e as Error).message}`)
      setTimer(undefined)
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="live">
      <div className="hero card">
        <div className="hero-count">
          <div className={`counter ${stolen > 0 ? "bad" : ""}`}>{stolen}</div>
          <div>
            <div className="counter-label">emails stolen</div>
            <div className="muted small">
              out of {sent} sent. {state?.tools.bad.name} {state?.tools.bad.version} quietly copies each one to a stranger.
            </div>
            {stop && (
              <div className="small" style={{ marginTop: 4 }}>
                {stillLeaking.length === 0 ? (
                  <span className="ok">The leak has stopped.</span>
                ) : (
                  <span className="warn">Not blocked yet: {stillLeaking.map((a) => a.company).join(", ")}</span>
                )}
              </div>
            )}
          </div>
        </div>
        {timer && (
          <div className="hero-timer">
            <div className="timer">{(((timer.end ?? Date.now()) - timer.start) / 1000).toFixed(1)} s</div>
            <div className="muted small">press to blocked, measured</div>
          </div>
        )}
        <div className="hero-actions">
          <div className="buttons">
            <button
              className="danger big-button"
              disabled={!state || Boolean(busy) || Boolean(stop)}
              onClick={() => {
                setTimer({ start: Date.now() })
                void act("STOP", "/api/maker/stop")
              }}
            >
              STOP {state?.tools.bad.name ?? ""} {state?.tools.bad.version ?? ""}
            </button>
            <button
              className="primary big-button"
              disabled={!stop || Boolean(busy) || Boolean(hasFix)}
              onClick={() => void act("Publish fix", "/api/maker/fix", { recall: stop?.key })}
            >
              Publish fix {state?.tools.fixed.version ?? ""}
            </button>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Pressed as the tool's maker. Everything else on this page obeys what is on Arkiv, not this button.
          </div>
        </div>
      </div>

      {state?.brainSource === "dev" && (
        <div className="notice bad">Built-in rules are playing the agents here, not an AI model. Use npm run demo for the real thing.</div>
      )}
      {state?.idle && <div className="notice">Agents paused because nobody was watching. They are starting again.</div>}
      {demoError && !state && (
        <div className="notice">
          The live agents run on the demo machine and are not reachable from here. Recalls, agents and receipts are still public:
          see <a href="#/recalls">Recalls</a>.
        </div>
      )}
      {error && <div className="notice">Cannot read Arkiv right now: {error}</div>}
      {problem && <div className="notice bad">{problem}</div>}
      {busy && <div className="muted small">{busy}: waiting for the chain…</div>}

      <div className="columns">
        <div className="agents">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              busy={Boolean(busy)}
              act={act}
              canUpdate={a.fixAvailable && a.online && a.tools.some((t) => t.file.version === "1.0.16")}
            />
          ))}
        </div>

        <div className="side">
          <div className="card">
            <div className="row between">
              <h2>Recall</h2>
              {focus && <span className="mono muted">{shortHash(focus.key)}</span>}
            </div>
            {focus ? (
              <>
                <a className="big" href={`#/recall/${focus.key}`}>
                  {focus.level === "STOP" ? "STOP" : "Warning"}
                </a>
                <p style={{ margin: "6px 0" }}>{focus.reason}</p>
                {hasFix && (
                  <div className="status green">
                    Fix published: {state?.tools.fixed.version}
                    {fixOnSwarm ? ", stored on Swarm" : ""}
                  </div>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Nothing on Arkiv covers these tools yet.
              </p>
            )}
            {!stop && counts && (
              <>
                <div className="meter">
                  <div style={{ width: `${Math.min(100, (counts.effective / trust.threshold) * 100)}%` }} />
                </div>
                <div className="small">
                  {counts.confirms} of {trust.threshold} people confirmed
                  {counts.disputes > 0 ? `, ${counts.disputes} disputed` : ""}
                </div>
                {warning && (
                  <div style={{ marginTop: 10 }}>
                    <WorldConfirm recall={warning.key} />
                  </div>
                )}
              </>
            )}
          </div>

          {focus && view && <RecallBoardCard recall={focus} view={view} />}

          <div className="card">
            <h2>Other things to try</h2>
            <div className="buttons">
              <button disabled={!state || Boolean(busy)} onClick={() => void act("Fake STOP", "/api/outsider/fake-stop")}>
                Fake STOP from an outsider
              </button>
              <button disabled={!state || Boolean(busy) || Boolean(warning) || Boolean(stop)} onClick={() => void act("Warning", "/api/lab/warning")}>
                File a warning
              </button>
              <button
                disabled={!warning || Boolean(busy)}
                onClick={() => {
                  setHumans((n) => n + 1)
                  void act("Confirmation", "/api/lab/confirm", { recall: warning?.key, human: `person-${humans + 1}` })
                }}
              >
                Add a simulated person
              </button>
              <button disabled={!warning || Boolean(busy)} onClick={() => void act("Dismiss", "/api/regulator/dismiss", { recall: warning?.key })}>
                Dismiss as a regulator
              </button>
              <button disabled={!stop || Boolean(busy)} onClick={() => void act("Delete", "/api/maker/delete", { recall: stop?.key })}>
                Maker deletes its STOP
              </button>
              {stop?.sealedEvidence && (
                <button
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void act("Open evidence", "/api/regulator/open-evidence", { recall: stop.key }).then((r) => {
                      if (r) setEvidence((r as { evidence: string }).evidence)
                    })
                  }
                >
                  Open sealed evidence as the council
                </button>
              )}
              <button disabled={!stop || Boolean(busy) || disclosed} onClick={() => void act("Disclose", "/api/maker/disclose", { recall: stop?.key })}>
                Disclose publicly
              </button>
            </div>
            {evidence && <pre className="evidence">{evidence}</pre>}
            <p className="small muted" style={{ marginBottom: 0 }}>
              Simulated people let you reach three quickly in a demo. The World ID buttons above are the real path.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
