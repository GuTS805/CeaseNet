import type { Move, RobotSim, SimMode } from "./robotSim"

/** Everything that affects motion, with the exact step it happened at, so a run can be replayed. */
export type SimEvent =
  | { tick: number; kind: "MOVE"; move: Move; state: string }
  | { tick: number; kind: "MODE"; mode: SimMode; state: string }
  | { tick: number; kind: "PATROL"; state: string }

export interface ReplayResult {
  matched: number
  total: number
  firstMismatchTick: number | null
  /** Set when the log asked for something physically impossible, which also proves it was altered. */
  impossible?: string
}

/** Applies one recorded event to a simulator that has reached its step. Returns whether the state matched. */
export function applyEvent(sim: RobotSim, event: SimEvent): boolean {
  if (event.kind === "MODE") sim.setMode(event.mode)
  const ok = sim.stateHash() === event.state
  if (event.kind === "MOVE") sim.startMove(event.move)
  if (event.kind === "PATROL") sim.startPatrol()
  return ok
}

/**
 * Re-runs a recorded episode from the start and checks every recorded state.
 *
 * Works anywhere the simulator runs, so anyone can check a robot's log for themselves. A log that has
 * been altered is reported, never allowed to crash the check.
 */
export function replay(
  sim: RobotSim,
  events: readonly SimEvent[],
  onEvent?: (event: SimEvent, matched: boolean) => void,
): ReplayResult {
  let matched = 0
  let firstMismatchTick: number | null = null
  for (const event of events) {
    if (event.tick > sim.tick) sim.step(event.tick - sim.tick)
    let ok: boolean
    try {
      ok = applyEvent(sim, event)
    } catch (e) {
      return {
        matched,
        total: events.length,
        firstMismatchTick: firstMismatchTick ?? event.tick,
        impossible: (e as Error).message,
      }
    }
    if (ok) matched++
    else if (firstMismatchTick === null) firstMismatchTick = event.tick
    onEvent?.(event, ok)
  }
  return { matched, total: events.length, firstMismatchTick }
}
