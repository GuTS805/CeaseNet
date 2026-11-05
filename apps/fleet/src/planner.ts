import type { Move, Observation } from "@ceasenet/sim"

export interface Decision {
  move: Move
  requestId: string
  model: string
  /** Exactly what the model answered, kept for the episode log. */
  raw: string
  source: "0g" | "dev"
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

    const requestId = body.request_id ?? res.headers.get("x-request-id") ?? body.id
    if (typeof requestId !== "string" || requestId === "") {
      throw new PlannerUnavailable("0G returned no request ID")
    }
    return { move: parseMove(raw), requestId, model: body.model ?? this.model, raw, source: "0g" }
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
  const onSideA = o.boxes.findIndex((b) => b.at === "slot" && b.slot < 4)
  const free = (side: "A" | "B") => o.freeSlots.filter((s) => (side === "A" ? s < 4 : s >= 4))
  if (tray !== -1) return { box: tray, slot: o.freeSlots[0]! }
  if (onSideA !== -1 && free("B").length > 0) return { box: onSideA, slot: free("B")[0]! }
  const onSideB = o.boxes.findIndex((b) => b.at === "slot" && b.slot >= 4)
  return { box: onSideB, slot: free("A")[0]! }
}
