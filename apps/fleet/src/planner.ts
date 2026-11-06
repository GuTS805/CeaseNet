import type { Move, Observation } from "@ceasenet/sim"

export interface Decision {
  move: Move
  requestId: string
  model: string
  /** Exactly what the model answered, kept for the episode log. */
  raw: string
  source: "0g" | "dev"
  /** The 0G provider that answered, when 0G reports one. */
  provider?: string
}

/** The planner could not be reached. The robot must pause safely: it may not invent a decision. */
export class PlannerUnavailable extends Error {
  override name = "PlannerUnavailable"
}

/** The planner answered, but not with a move. */
export class PlannerInvalidReply extends Error {
  override name = "PlannerInvalidReply"
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
  }
}

export interface Planner {
  decide(observation: Observation, prompt: string, signal?: AbortSignal): Promise<Decision>
}

const ROUTER = "https://router-api.0g.ai/v1"
const TIMEOUT_MS = 20_000

/** Pulls a move out of a model's reply, tolerating code fences around the JSON. */
export function parseMove(text: string): Move {
  const match = text.match(/\{[^{}]*\}/)
  if (!match) throw new PlannerInvalidReply("no JSON object in the reply", text)
  let value: unknown
  try {
    value = JSON.parse(match[0])
  } catch {
    throw new PlannerInvalidReply("reply is not valid JSON", text)
  }
  const { box, slot } = value as { box?: unknown; slot?: unknown }
  if (typeof box !== "number" || typeof slot !== "number") {
    throw new PlannerInvalidReply("reply has no box and slot numbers", text)
  }
  return { box, slot }
}

/**
 * 0G puts its own ID in `x_0g_trace`. The x-request-id header can hold two IDs joined by a comma, and the
 * last one is the same ID, so a joined value must never be stored.
 */
function findRequestId(body: any, headers: Headers): unknown {
  const header = headers.get("x-request-id")?.split(",").pop()?.trim()
  return body.x_0g_trace?.request_id ?? body.request_id ?? header ?? body.id
}

/** Calls a model on 0G for every decision. */
export class ZeroGPlanner implements Planner {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(observation: Observation, prompt: string, signal?: AbortSignal): Promise<Decision> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(`${ROUTER}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          // A move is a small choice. With reasoning on, one decision took up to 18 s and the robot stood idle.
          reasoning_effort: "none",
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify(observation) },
          ],
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      throw new PlannerUnavailable(`0G unreachable: ${(e as Error).message}`)
    }

    const text = await res.text().catch(() => "")
    if (!res.ok) throw new PlannerUnavailable(`0G returned ${res.status}: ${text.slice(0, 200)}`)

    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new PlannerUnavailable("0G returned something that is not JSON")
    }
    const raw = body?.choices?.[0]?.message?.content
    if (typeof raw !== "string") throw new PlannerUnavailable("0G returned no answer")

    const requestId = findRequestId(body, res.headers)
    if (typeof requestId !== "string" || requestId === "") {
      throw new PlannerUnavailable("0G returned no request ID")
    }
    const provider = body.x_0g_trace?.provider ?? res.headers.get("x-provider") ?? undefined
    return { move: parseMove(raw), requestId, model: body.model ?? this.model, raw, source: "0g", provider }
  }
}

/**
 * Local development only, and never a fallback: it runs only when explicitly turned on at start-up, and
 * everything it decides is labelled as coming from it. A demo must use 0G.
 */
export class DevPlanner implements Planner {
  private count = 0

  async decide(observation: Observation): Promise<Decision> {
    const move = chooseMove(observation)
    return {
      move,
      requestId: `dev-${++this.count}`,
      model: "dev-rules",
      raw: JSON.stringify(move),
      source: "dev",
    }
  }
}

/** The job description in the planner prompt, as plain rules. */
export function chooseMove(o: Observation): Move {
  const tray = o.boxes.findIndex((b) => b.at === "tray")
  if (tray !== -1) return { box: tray, slot: o.freeSlots[0]! }
  const box = o.lastMoved === null ? 0 : (o.lastMoved + 1) % o.boxes.length
  const place = o.boxes[box]!
  const onSideA = place.at === "slot" && place.slot < 4
  const slot = o.freeSlots.find((s) => (onSideA ? s >= 4 : s < 4)) ?? o.freeSlots[0]!
  return { box, slot }
}
