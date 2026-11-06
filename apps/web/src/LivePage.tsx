import { useEffect, useMemo, useRef, useState } from "react"
import { countConfirmations, fleetTrust, type RecallRow } from "@ceasenet/core"
import { RecallBoardCard } from "./Board"
import { FLEET_URL, fleetGet, fleetPost, type FleetState, type LiveFrame, shortHash, statusColour, statusLabel, useFleetView, usePoll } from "./lib"
import { Stage, type StagePose } from "./Stage"

const trust = fleetTrust()

function useLiveFrames() {
  const latest = useRef<LiveFrame>({ robots: [] })
  const [connected, setConnected] = useState(false)
  const [, redraw] = useState(0)
  useEffect(() => {
    let socket: WebSocket
    let closed = false
    let retry: ReturnType<typeof setTimeout>
    const connect = () => {
      socket = new WebSocket(`${FLEET_URL.replace(/^http/, "ws")}/live`)
      socket.onopen = () => setConnected(true)
      socket.onmessage = (e) => {
        latest.current = JSON.parse(e.data as string) as LiveFrame
        redraw((n) => n + 1)
      }
      socket.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      socket.close()
    }
  }, [])
  return { latest, connected }
}

/** The demo screen: robots on the left, the public record and the controls on the right. */
export function LivePage() {
  const { latest, connected } = useLiveFrames()
  const { data: state } = usePoll<FleetState>(() => fleetGet<FleetState>("/api/state"), 2000)
  const { data: view, error } = useFleetView()
  const [busy, setBusy] = useState<string>()
  const [problem, setProblem] = useState<string>()
  const [timer, setTimer] = useState<{ start: number; end?: number }>()
  const [, tick] = useState(0)

  const poses = useMemo(
    () => (): StagePose[] => latest.current.robots.map((r) => ({ id: r.id, q: r.q, status: r.status })),
    [latest],
  )

  const robots = latest.current.robots

  // The timer runs from pressing STOP until every online robot has stopped.
  useEffect(() => {
    if (!timer || timer.end) return
    const online = robots.filter((r) => r.online)
    if (online.length > 0 && online.every((r) => r.status === "STOPPED")) setTimer({ ...timer, end: Date.now() })
    const id = setTimeout(() => tick((n) => n + 1), 50)
    return () => clearTimeout(id)
  })

  const recalls = useMemo(
    () => (view && state ? view.recalls.filter((r) => r.artifact === state.recalledHash) : []),
    [view, state],
  )
  const stop = recalls.find((r) => r.level === "STOP" && r.creator.toLowerCase() === trust.stopKeys.values().next().value)
  const advisory = recalls.find((r) => r.level === "ADVISORY")
  const focus: RecallRow | undefined = stop ?? advisory
  const hasFix = stop && view?.lifts.some((l) => l.recall === stop.key && l.kind === "FIX")
  const counts = advisory && view ? countConfirmations(advisory, view.endorsements, view.block, trust) : undefined

  const act = async (name: string, path: string, body: unknown = {}) => {
    setBusy(name)
    setProblem(undefined)
    try {
      await fleetPost(path, body)
    } catch (e) {
      setProblem(`${name}: ${(e as Error).message}`)
      setTimer(undefined)
    } finally {
      setBusy(undefined)
    }
  }

  const plannerUp = state?.robots.every((r) => r.plannerUp) ?? true
  const robot3 = state?.robots.find((r) => r.id === 3)

  return (
    <div className="live">
      <div className="stage">
        {connected ? (
          <Stage poses={poses} />
        ) : (
          <div className="stage-note">
            <div>
              <div className="big">Robots are not connected</div>
              <p>The live view needs the robots running on this machine. Everything on the right is read straight from Arkiv.</p>
            </div>
          </div>
        )}
        <div className="chips">
          {(state?.robots ?? []).map((r) => {
            const live = robots.find((x) => x.id === r.id)
            const status = live?.status ?? r.status
            return (
              <div className="chip" key={r.id}>
                <div className="row between">
                  <a href={`#/plate/${r.address}`} style={{ pointerEvents: "auto" }}>
                    Robot {r.id}
                  </a>
                  <span className={`status ${statusColour(status)}`}>{statusLabel(status)}</span>
                </div>
                <div className="sub">
                  Policy {r.version} · {r.online ? "online" : "internet cut"} · {r.decisions} decisions
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="side">
        {state?.plannerSource === "dev" && (
          <div className="notice bad">
            Development planner in use. These decisions are not from 0G. Add ZG_API_KEY before any demo.
          </div>
        )}
        {error && <div className="notice">Cannot read Arkiv right now: {error}</div>}

        <div className="card">
          <h2>Maker</h2>
          <div className="buttons">
            <button
              className="danger"
              disabled={!state || Boolean(busy) || Boolean(stop)}
              onClick={() => {
                setTimer({ start: Date.now() })
                void act("STOP", "/api/maker/stop")
              }}
            >
              STOP policy 1.5.2
            </button>
            <button
              className="primary"
              disabled={!stop || Boolean(busy) || Boolean(hasFix)}
              onClick={() => void act("Publish fix", "/api/maker/fix", { recall: stop?.key })}
            >
              Publish fix 1.5.3
            </button>
          </div>
          <h2 style={{ marginTop: 10 }}>Demo controls</h2>
          <div className="buttons">
            <button
              disabled={!robot3 || Boolean(busy)}
              onClick={() => void act("Robot 3 internet", "/api/robots/3/network", { up: !robot3?.online })}
            >
              {robot3?.online === false ? "Restore robot 3 internet" : "Cut robot 3 internet"}
            </button>
            <button
              disabled={!state || Boolean(busy)}
              onClick={() => void act("0G", "/api/planner", { up: !plannerUp })}
            >
              {plannerUp ? "Switch 0G off" : "Switch 0G on"}
            </button>
            <button
              disabled={!robot3 || robot3.version === "1.5.3" || !hasFix || Boolean(busy)}
              onClick={() => void act("Update robot 3", "/api/robots/3/update")}
            >
              Update robot 3
            </button>
          </div>
          {problem && <p className="error">{problem}</p>}
          {busy && <p className="muted small">{busy}: waiting for the chain…</p>}
        </div>
        <div className="card">
          <div className="row between">
            <h2>Recall</h2>
            {timer && (
              <div style={{ textAlign: "right" }}>
                <div className="timer">{(((timer.end ?? Date.now()) - timer.start) / 1000).toFixed(1)} s</div>
                <div className="muted small">press to stop, measured</div>
              </div>
            )}
          </div>
          {focus ? (
            <>
              <div className="row between">
                <a className="big" href={`#/recall/${focus.key}`}>
                  {focus.level === "STOP" ? "STOP" : "Warning"}
                </a>
                <span className="mono muted">{shortHash(focus.key)}</span>
              </div>
              <p style={{ margin: "6px 0" }}>{focus.reason}</p>
              {hasFix && <div className="status green">Fix published: policy 1.5.3</div>}
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No recall on the software these robots run.
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
            </>
          )}
        </div>

        {focus && view && <RecallBoardCard recall={focus} view={view} />}

      </div>
    </div>
  )
}
