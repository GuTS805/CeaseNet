import { useEffect, useMemo, useRef, useState } from "react"
import { applyEvent, RobotSim, type SimEvent } from "@ceasenet/sim"
import { fleetGet, shortHash, statusLabel } from "./lib"
import { getMujoco, Stage, type StagePose } from "./Stage"

interface Decision {
  tick: number
  requestId: string
  model: string
  source: string
  move: { box: number; slot: number }
  softwareHash: string
}

interface Episode {
  robot: string
  events: SimEvent[]
  decisions: Decision[]
}

/** Long runs replay faster, so checking one takes about 20 seconds at most. */
const TARGET_FRAMES = 60 * 20
const MIN_STEPS_PER_FRAME = 16

/**
 * Re-runs a robot's recorded episode in real physics, right here in the browser, and compares every
 * recorded state. A changed log shows up as a mismatch.
 */
export function ReplayPage({ id }: { id: number }) {
  const [episode, setEpisode] = useState<Episode>()
  const [problem, setProblem] = useState<string>()
  const [progress, setProgress] = useState({ event: 0, matched: 0, mismatched: 0, status: "RUNNING", done: false })
  const pose = useRef<StagePose>({ id: 1, q: [] })
  const poses = useMemo(() => () => (pose.current.q.length ? [pose.current] : []), [])

  useEffect(() => {
    fleetGet<Episode>(`/api/robots/${id}/episode`)
      .then(setEpisode)
      .catch((e) => setProblem((e as Error).message))
  }, [id])

  useEffect(() => {
    if (!episode) return
    let stop = false
    let frame = 0
    ;(async () => {
      const sim = new RobotSim(await getMujoco())
      let index = 0
      let matched = 0
      let mismatched = 0
      let status = "RUNNING"
      const lastTick = episode.events[episode.events.length - 1]?.tick ?? 0
      const stepsPerFrame = Math.max(MIN_STEPS_PER_FRAME, Math.ceil(lastTick / TARGET_FRAMES))
      const next = () => {
        if (stop) return
        let budget = stepsPerFrame
        while (budget > 0 && index < episode.events.length) {
          const event = episode.events[index]!
          const gap = event.tick - sim.tick
          if (gap > 0) {
            const n = Math.min(gap, budget)
            sim.step(n)
            budget -= n
            if (n < gap) break
          }
          try {
            if (applyEvent(sim, event)) matched++
            else mismatched++
          } catch {
            mismatched++
          }
          if (event.kind === "MODE") status = event.mode
          index++
        }
        pose.current = { id: 1, q: sim.qpos(), status }
        const done = index >= episode.events.length
        setProgress({ event: index, matched, mismatched, status, done })
        if (!done) frame = requestAnimationFrame(next)
      }
      next()
    })().catch((e) => setProblem((e as Error).message))
    return () => {
      stop = true
      cancelAnimationFrame(frame)
    }
  }, [episode])

  if (problem) {
    return (
      <div className="page notice bad">
        Cannot load this robot's episode: {problem}. The robots must be running on this machine until logs are read from 0G Storage.
      </div>
    )
  }
  if (!episode) return <div className="page muted">Loading the episode…</div>

  const verified = progress.done && progress.mismatched === 0 && progress.matched > 0
  return (
    <div className="live">
      <div className="stage">
        <Stage poses={poses} count={1} />
      </div>
      <div className="side">
        <div className="card">
          <h2>Replay of robot {id}</h2>
          <div className="big">
            {progress.matched} of {episode.events.length} states match
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className={`status ${progress.mismatched > 0 ? "red" : verified ? "green" : "amber"}`}>
              {progress.mismatched > 0
                ? `${progress.mismatched} do not match: this log was changed`
                : verified
                  ? "Log verified"
                  : `Replaying: ${statusLabel(progress.status as any)}`}
            </span>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            This runs the same physics engine in your browser, from the same start, with the same recorded commands. Every
            state must match exactly.
          </p>
        </div>
        <div className="card">
          <h2>Decisions ({episode.decisions.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Request ID</th>
                <th>Move</th>
                <th>Software</th>
              </tr>
            </thead>
            <tbody>
              {episode.decisions.slice(-30).map((d) => (
                <tr key={d.requestId + d.tick}>
                  <td className="mono">{d.requestId}</td>
                  <td>
                    Box {d.move.box} to slot {d.move.slot}
                  </td>
                  <td className="mono muted">{shortHash(d.softwareHash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
