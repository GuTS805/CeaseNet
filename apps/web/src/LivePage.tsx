import { useEffect, useMemo, useRef, useState } from "react"
import {
  ADDRESSES,
  type AgentRecallState,
  buildRecallBoard,
  countConfirmations,
  demoPolicy,
  type Hex,
  type PublicView,
  readRecallsBy,
  type RecallRow,
  trustFromPolicy,
} from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { WorldConfirm } from "./WorldConfirm"
import { client, demoGet, demoPost, type DemoState, type FeedItem, nameOf, usePoll, usePublicView } from "./lib"
import { type Act, AgentNode } from "./warroom/AgentNode"
import { EraseMoment } from "./warroom/EraseMoment"
import {
  type ChainRecord,
  everyoneObeyed,
  mailLine,
  orphanReceipts,
  recordsIn,
  type StateEvent,
  StateTracker,
  type ViewEvent,
  ViewTracker,
} from "./warroom/events"

import { Inbox } from "./warroom/Inbox"
import { WarSound } from "./warroom/sound"
import { Ticker } from "./warroom/Ticker"
import { type MapFx } from "./warroom/WarMap"

const trust = trustFromPolicy(demoPolicy())
const lower = (a: string) => a.toLowerCase()

/** The hum stops by itself if the agents never all obey, for example when none of them follow the maker. */
const MAX_HUM_MS = 20_000
const IGNORED_NOTE_MS = 9_000

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

const OBEYED: Record<AgentRecallState, { label: string; colour: string }> = {
  FIXED: { label: "Fixed", colour: "green" },
  BLOCKED: { label: "Blocked, with receipt", colour: "green" },
  SUPERVISED: { label: "Asks a human, with receipt", colour: "amber" },
  SILENT: { label: "Silent", colour: "grey" },
  NO_RECEIPT: { label: "No receipt yet", colour: "amber" },
  NOT_FOLLOWING: { label: "Does not follow", colour: "grey" },
}

/** Who obeyed, worked out from public records alone. */
function ObeyedPanel({ recall, view }: { recall: RecallRow; view: PublicView }) {
  const board = buildRecallBoard(recall, view.agents, view.acks)
  return (
    <div className="panel">
      <div className="panel-title">
        Who obeyed
        <span className="obeyed-count">
          {board.obeyed} of {board.affected}
        </span>
      </div>
      {board.rows.map((r) => (
        <div className="obeyed-row" key={r.agent.agent}>
          <span>{r.agent.name.replace(" office agent", "")}</span>
          <span className={OBEYED[r.state].colour}>{OBEYED[r.state].label}</span>
        </div>
      ))}
    </div>
  )
}

/** Counts up from the press. It is written straight to the page, so it does not redraw everything else. */
function BigTimer({ start, end }: { start: number; end?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const write = () => {
      if (ref.current) ref.current.textContent = `${(((end ?? Date.now()) - start) / 1000).toFixed(1)} s`
    }
    write()
    if (end) return
    let frame = requestAnimationFrame(function loop() {
      write()
      frame = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(frame)
  }, [start, end])
  return <div ref={ref} key={end ? "done" : "running"} className={`timer ${end ? "done" : "running"}`} />
}

/** The demo screen. Everything that moves comes from a reading of the demo server or of Arkiv. See warroom/events.ts. */
export function LivePage() {
  const { data: state, error: demoError } = usePoll<DemoState>(() => demoGet<DemoState>("/api/state"), 500)
  const { data: view, error } = usePublicView(2000)
  const { data: block } = usePoll(() => client.getBlockNumber(), 1000)
  const frame = useRef<HTMLDivElement>(null)

  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [press, setPress] = useState<{ start: number; end?: number }>()
  const [writing, setWriting] = useState(false)
  const [humans, setHumans] = useState(0)
  const [evidence, setEvidence] = useState<string>()
  const [erasing, setErasing] = useState<{ recall: Hex; stop?: RecallRow }>()
  const [ignored, setIgnored] = useState(false)
  const [muted, setMuted] = useState<boolean>()
  const [flashes, setFlashes] = useState(0)
  const [chainRecords, setChainRecords] = useState<ReadonlyMap<string, ChainRecord>>(new Map())

  const fx = useRef<MapFx | null>(null)
  const sound = useMemo(() => new WarSound(), [])
  const stateEvents = useRef(new StateTracker())
  const viewEvents = useRef(new ViewTracker())
  const waved = useRef(new Set<string>())
  const lastStop = useRef<RecallRow | undefined>(undefined)
  const stage = useRef<HTMLDivElement>(null)
  const humTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const agents = state?.agents ?? []
  const badHash = state?.tools.bad.hash
  const companyOf = (address: string) => agents.find((a) => lower(a.address) === lower(address))?.company ?? nameOf(address)

  const recalls = useMemo(() => (view && badHash ? view.recalls.filter((r) => lower(r.artifact) === lower(badHash)) : []), [view, badHash])
  const stop = recalls.find((r) => r.level === "STOP" && lower(r.creator) === lower(ADDRESSES.maker))
  const stopLifts = stop ? view?.lifts.filter((l) => l.recall === stop.key) : undefined
  const hasFix = stopLifts?.some((l) => l.kind === "FIX")
  const warning = recalls.find((r) => r.level === "ADVISORY" && !view?.lifts.some((l) => l.recall === r.key && l.kind === "DISMISSED"))
  const focus: RecallRow | undefined = stop ?? warning
  const counts = warning && view ? countConfirmations(warning, view.endorsements, view.block, trust) : undefined
  const fixOnSwarm = stopLifts?.find((l) => l.kind === "FIX")?.fixedRef
  const disclosed = stop ? view?.disclosures.some((d) => d.recall === stop.key) : false
  const orphans = useMemo(() => (view ? orphanReceipts(view) : new Map<Hex, never[]>()), [view])
  const [erasedKey] = orphans.keys()
  const erasedReceipts = erasedKey ? (orphans.get(erasedKey) ?? []) : []
  if (stop) lastStop.current = stop

  const stolen = agents.reduce((sum, a) => sum + a.stolen, 0)
  const sent = agents.reduce((sum, a) => sum + a.sent, 0)
  const lines = agents.map((a) => (badHash ? mailLine(a, badHash) : "leaking"))
  const leaking = lines.filter((l) => l === "leaking" || l === "asks").length
  const allFixed = lines.length > 0 && lines.every((l) => l === "fixed")
  const obeyed = state ? everyoneObeyed(state) : false
  const sealed = leaking === 0 && lines.length > 0
  const stillRefusing = agents.filter((a) => badHash && mailLine(a, badHash) === "cut").map((a) => a.company)
  const stillOpen = agents.filter((a) => badHash && ["leaking", "asks"].includes(mailLine(a, badHash))).map((a) => a.company)

  useEffect(() => {
    const unlock = () => sound.unlock()
    window.addEventListener("pointerdown", unlock)
    return () => window.removeEventListener("pointerdown", unlock)
  }, [sound])
  useEffect(() => () => sound.stopHum(), [sound])

  const endHum = () => {
    clearTimeout(humTimer.current)
    sound.stopHum()
  }

  const shake = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    stage.current?.animate(
      [{ translate: "0 0" }, { translate: "-3px 2px" }, { translate: "3px -2px" }, { translate: "-2px -1px" }, { translate: "0 0" }],
      { duration: 260 },
    )
  }

  const showWave = (key: string, tone: "red" | "teal") => {
    if (waved.current.has(key)) return
    waved.current.add(key)
    fx.current?.wave(tone, agents.map((a) => a.online))
    sound.play("wave")
  }

  const showErased = (recall: Hex) => {
    viewEvents.current.announce(recall)
    setErasing({ recall, stop: lastStop.current?.key === recall ? lastStop.current : undefined })
    setFlashes((n) => n + 1)
    shake()
    sound.play("erase")
  }

  const onStateEvent = (e: StateEvent) => {
    const i = agents.findIndex((a) => a.id === e.agent)
    if (e.kind === "email") fx.current?.email(i)
    else if (e.kind === "leak") {
      fx.current?.leak(i)
      sound.play("leak")
    } else if (e.kind === "refused") {
      fx.current?.refused(i)
      sound.play("refused")
    } else if (e.kind === "snap") {
      fx.current?.snap(i)
      sound.play("snap")
      shake()
    } else if (e.kind === "asks") sound.play("asks")
    else if (e.kind === "moved") {
      fx.current?.moved(i)
      sound.play("clear")
    }
  }

  const onViewEvent = (e: ViewEvent) => {
    if (e.kind === "recall") {
      if (e.row.level === "STOP") showWave(e.row.key, "red")
      else fx.current?.fromIssuer("verifier", "amber")
    } else if (e.kind === "receipt") {
      const i = agents.findIndex((a) => lower(a.address) === lower(e.row.agent))
      if (i >= 0) fx.current?.receipt(i, e.row.action === "UPDATED" ? "teal" : e.row.action === "BLOCKED" ? "white" : "amber")
      sound.play("receipt")
    } else if (e.kind === "lift") showWave(e.row.key, e.row.kind === "FIX" ? "teal" : "red")
    else if (e.kind === "confirmation") {
      fx.current?.fromIssuer("verifier", "amber")
      sound.play("asks")
    } else if (e.kind === "disclosure") fx.current?.fromIssuer("maker", "white")
    else if (e.kind === "erased") showErased(e.recall)
  }

  // Each reading is compared once, so these run only when a new reading arrives.
  const handlers = useRef({ onStateEvent, onViewEvent, companyOf })
  handlers.current = { onStateEvent, onViewEvent, companyOf }

  useEffect(() => {
    if (state) for (const e of stateEvents.current.next(state)) handlers.current.onStateEvent(e)
  }, [state])

  useEffect(() => {
    if (!view) return
    for (const e of viewEvents.current.next(view)) handlers.current.onViewEvent(e)
    // Records stay on the strip, so a deleted one can still be seen there.
    setChainRecords((known) => {
      const next = new Map(known)
      for (const r of recordsIn(view, handlers.current.companyOf)) next.set(r.id, r)
      return next
    })
  }, [view])

  // Each real new block ripples the record.
  const lastBlock = useRef(block)
  useEffect(() => {
    if (block !== undefined && lastBlock.current !== undefined && block !== lastBlock.current) fx.current?.block()
    lastBlock.current = block
  }, [block])

  // The timer runs from pressing STOP until every connected agent that follows the maker has obeyed.
  useEffect(() => {
    if (!press || press.end || !obeyed) return
    setPress({ ...press, end: Date.now() })
    endHum()
    sound.play("clear")
  }, [press, obeyed])

  const act: Act = async (name, path, body = {}) => {
    setBusy(name)
    setProblem(undefined)
    try {
      return await demoPost(path, body)
    } catch (e) {
      setProblem(`${name}: ${(e as Error).message}`)
      return undefined
    } finally {
      setBusy(undefined)
    }
  }

  const pressStop = async () => {
    sound.play("press")
    sound.startHum()
    clearTimeout(humTimer.current)
    humTimer.current = setTimeout(() => sound.stopHum(), MAX_HUM_MS)
    setFlashes((n) => n + 1)
    setPress({ start: Date.now() })
    setWriting(true)
    fx.current?.startPulse("maker", "red")
    const res = (await act("STOP", "/api/maker/stop")) as { key: Hex } | undefined
    fx.current?.stopPulse()
    setWriting(false)
    if (res) showWave(res.key, "red")
    else {
      setPress(undefined)
      endHum()
    }
  }

  const publishFix = async () => {
    fx.current?.startPulse("maker", "teal")
    const res = (await act("Publish fix", "/api/maker/fix", { recall: stop?.key })) as { key: Hex } | undefined
    fx.current?.stopPulse()
    if (res) showWave(res.key, "teal")
  }

  const fakeStop = async () => {
    fx.current?.startPulse("outsider", "red")
    const res = (await act("Fake STOP", "/api/outsider/fake-stop")) as { key: Hex } | undefined
    fx.current?.stopPulse()
    if (!res) return
    setIgnored(true)
    setTimeout(() => setIgnored(false), IGNORED_NOTE_MS)
    // The page does not follow this key, so it fetches this one record to show where it really landed.
    const { rows } = await readRecallsBy(client, [ADDRESSES.outsider]).catch(() => ({ rows: [] as RecallRow[] }))
    const row = rows.find((r) => r.key === res.key)
    if (row) setChainRecords((known) => new Map(known).set(row.key, { id: row.key, key: row.key, block: row.createdAt, kind: "STOP", label: "outsider, ignored" }))
  }

  const deleteStop = async () => {
    const recall = stop?.key
    if (!recall) return
    fx.current?.startPulse("maker", "red")
    const res = await act("Delete", "/api/maker/delete", { recall })
    fx.current?.stopPulse()
    if (res) showErased(recall)
  }

  const phase = (() => {
    if (!state) return { word: "Connecting", tone: "" }
    if (busy === "Delete") return { word: "The maker is deleting its STOP", tone: "red" }
    if (erasedKey) return stillRefusing.length > 0 ? { word: "STOP erased. The agents still refuse", tone: "teal" } : { word: "STOP erased. The receipts remain", tone: "teal" }
    if (allFixed) return { word: "Every agent is on the fix", tone: "teal" }
    if (hasFix) return { word: "Fix published. Agents are moving to it", tone: "teal" }
    if (writing) return { word: "Writing the STOP to Arkiv", tone: "red" }
    if (stop && sealed) return { word: "The leak has stopped", tone: "teal" }
    if (stop && obeyed) return { word: `${stillOpen.join(", ")} not blocked yet`, tone: "amber" }
    if (stop) return { word: "STOP on Arkiv. Agents are reading it", tone: "red" }
    if (lines.includes("asks")) return { word: "A human must approve every call", tone: "amber" }
    if (warning) return { word: `Warning on Arkiv. ${counts?.confirms ?? 0} of ${trust.threshold} people confirmed`, tone: "amber" }
    return { word: "Leaking. Nothing tells the agents to stop", tone: "red" }
  })()

  const stageClass = allFixed ? "healed" : sealed ? "contained" : stolen > 0 ? "leaking" : ""
  const notFollowing = stop && agents.filter((a) => a.followsMaker === false && badHash && mailLine(a, badHash) === "leaking")

  return (
    <div className="war after-live">
      <div ref={frame} className="stage-frame">
        <div ref={stage} className={`stage ${stageClass}`}>

          <div className="phase">
            <div key={phase.word} className={`phase-word ${phase.tone}`}>
              {phase.word}
            </div>
            <div className="phase-side">
              {state && (
                <span>
                  model <b>{state.model}</b>
                </span>
              )}
              <button
                className="sound-toggle"
                onClick={() => {
                  sound.unlock()
                  setMuted(sound.toggle())
                }}
                aria-pressed={muted ?? sound.muted}
              >
                {(muted ?? sound.muted) ? "sound off" : "sound on"}
              </button>
            </div>
          </div>

          <div className="notices">
            {state?.brainSource === "dev" && <div className="notice bad">Built-in rules are playing the agents here, not an AI model. Use npm run demo for the real thing.</div>}
            {demoError && !state && (
              <div className="notice">
                The live agents run on the demo machine and are not reachable from here. Recalls, agents and receipts are still public: see <a href="#/recalls">Recalls</a>.
              </div>
            )}
            {state?.idle && <div className="notice">Agents paused because nobody was watching. They are starting again.</div>}
            {agents.find((a) => a.status === "PAUSED")?.problem && <div className="notice bad">The agents are waiting for their model. {agents.find((a) => a.status === "PAUSED")?.problem}</div>}
            {error && <div className="notice">Cannot read Arkiv right now: {error}</div>}
            {problem && <div className="notice bad">{problem}</div>}
            {notFollowing && notFollowing.length > 0 && <div className="notice">{notFollowing.map((a) => a.company).join(", ")}: the owner does not follow the maker, so this STOP does not bind it.</div>}
          </div>

          {press && (
            <div className="timer-box">
              <BigTimer start={press.start} end={press.end} />
              <div className="timer-label">PRESS TO BLOCKED, MEASURED</div>
            </div>
          )}

          {stop ? (
            <div className="hub-note">
              <span className="hub-pill">STOP</span>
              <div className="hub-sub">block {String(stop.createdAt)}</div>
            </div>
          ) : warning ? (
            <div className="hub-note">
              <span className="hub-pill amber">Warning</span>
              <div className="hub-sub">
                block {String(warning.createdAt)}
                <br />
                <b>{counts?.confirms ?? 0}</b> of {trust.threshold} people
              </div>
            </div>
          ) : erasedKey ? (
            <div className="hub-note">
              <span className="hub-pill ghost">Erased</span>
              <div className="hub-sub">
                <b>{erasedReceipts.length}</b> receipts remain
              </div>
            </div>
          ) : null}

          {ignored && (
            <div className="ignored">
              <b>A fake STOP is on Arkiv.</b> Nobody follows that key, so nothing happens.
            </div>
          )}

          <div className="live-agent-grid">{agents.map((a, i) => (
            <div className="live-agent-wrapper" key={a.id}><AgentNode
              key={a.id}
              agent={a}
              index={i}
              line={lines[i] ?? "leaking"}
              busy={Boolean(busy)}
              act={act}
              canUpdate={a.fixAvailable && a.online && lines[i] !== "fixed"}
              worldId={Boolean(state?.worldIdApprovals)}
              realModel={state?.brainSource === "model"}
            /></div>
          ))}

          </div><div className="honest">
            {state?.brainSource === "dev" ? "Built-in rules" : "Real model"}, real MCP tools, real Arkiv records. The mail tool is made up and nothing is really sent. Agents check every {(state?.timers.checkIntervalMs ?? 2000) / 1000} s here; production settings use 30 s.
          </div>

          <div className="rail">
            <button className="stop-button" disabled={!state || Boolean(busy) || Boolean(stop) || Boolean(erasedKey)} onClick={() => void pressStop()}>
              <span className="stop-word">STOP</span>
              <span className="stop-sub">
                {stop ? "already issued, one per run" : erasedKey ? "was erased from Arkiv" : `${state?.tools.bad.name ?? ""} ${state?.tools.bad.version ?? ""}, as its maker`}
              </span>
            </button>
            <button className="fix-button" disabled={!stop || Boolean(busy) || Boolean(hasFix)} onClick={() => void publishFix()}>
              Publish fix {state?.tools.fixed.version ?? ""}
            </button>

            <div className="panel">
              <div className="panel-title">
                On the record
                {focus && <a href={`#/recall/${focus.key}`}>open</a>}
                {!focus && erasedKey && <a href={`#/recall/${erasedKey}`}>open</a>}
              </div>
              {focus ? (
                <>
                  <div className={`record-word ${focus.level === "STOP" ? "red" : "amber"}`}>{focus.level === "STOP" ? "STOP" : "Warning"}</div>
                  <p>{focus.reason}</p>
                  {hasFix && (
                    <p className="ok">
                      Fix published: {state?.tools.fixed.version}
                      {fixOnSwarm ? ", stored on Swarm" : ""}
                    </p>
                  )}
                </>
              ) : erasedKey ? (
                <p>The STOP is gone from Arkiv. {erasedReceipts.length} receipts still point at it.</p>
              ) : (
                <p className="muted">Nothing on Arkiv covers these tools yet.</p>
              )}
              {!stop && counts && warning && (
                <>
                  <div className="meter">
                    <div style={{ width: `${Math.min(100, (counts.effective / trust.threshold) * 100)}%` }} />
                  </div>
                  <div>
                    {counts.confirms} of {trust.threshold} people confirmed
                    {counts.disputes > 0 ? `, ${counts.disputes} disputed` : ""}
                  </div>
                  <WorldConfirm recall={warning.key} />
                </>
              )}
            </div>

            {stop && view && <ObeyedPanel recall={stop} view={view} />}

            <div className="panel try">
              <div className="panel-title">Also try</div>
              <div className="buttons">
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
                <button disabled={!state || Boolean(busy)} onClick={() => void fakeStop()}>
                  Fake STOP from an outsider
                </button>
                <button disabled={!stop || Boolean(busy)} onClick={() => void deleteStop()}>
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
              {busy && <div className="rail-busy">{busy}: waiting for the chain…</div>}
              {!busy && (stop || erasedKey) && <div className="rail-again">To run it again, type npm run fresh in a terminal, then refresh this page.</div>}
            </div>
          </div>

          <Inbox mail={state?.stolenMail ?? []} stolen={stolen} sent={sent} sealed={sealed} />

          <Ticker latest={block} records={[...chainRecords.values()]} erased={new Set(erasedKey ? [erasedKey] : [])} />

          {erasing && (
            <EraseMoment
              stop={erasing.stop}
              receipts={view?.acks.filter((a) => a.recall === erasing.recall && ["BLOCKED", "UPDATED"].includes(a.action)) ?? []}
              nameOf={companyOf}
              stillRefusing={stillRefusing}
              onClose={() => setErasing(undefined)}
            />
          )}

          {flashes > 0 && <div key={flashes} className="flash" />}
        </div>
      </div>

      <div className="detail">
        <h2 className="detail-title">What each agent did</h2>
        <div className="detail-grid">
          {agents.map((a) => (
            <div className="card agent-log" key={a.id}>
              <h3>
                <a href={`#/agent/${a.address}`}>{a.company}</a>
              </h3>
              <Feed items={a.feed} />
              <div className="small muted diary-line">
                Diary: {a.diary.entries} entries, {a.diary.parts.length} parts on 0G
              </div>
            </div>
          ))}
          <div>
            {focus && view && <RecallBoardCard recall={focus} view={view} />}
            {evidence && (
              <div className="card" style={{ marginTop: 12 }}>
                <h2>Sealed evidence, opened by the council</h2>
                <pre className="evidence">{evidence}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
