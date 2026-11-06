import type { ToolSpec } from "@ceasenet/guard"

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface BrainReply {
  message: Message
  requestId: string
  model: string
  source: "0g" | "dev"
}

/** The model could not be reached. The agent must wait: it may not act on a guess. */
export class BrainUnavailable extends Error {
  override name = "BrainUnavailable"
}

/** The model is fine, but this key has used up its requests for now. */
export class BrainBusy extends BrainUnavailable {
  override name = "BrainBusy"
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message)
  }
}

export interface Brain {
  next(messages: readonly Message[], tools: readonly ToolSpec[], signal?: AbortSignal): Promise<BrainReply>
}

const ROUTER = "https://router-api.0g.ai/v1"
/** Used when the router says it is busy without saying for how long. */
const DEFAULT_RETRY_S = 10
const MAX_BUSY_RETRIES = 5
const TIMEOUT_MS = 30_000

/**
 * 0G reports its own ID in `x_0g_trace`. The x-request-id header can hold two IDs joined by a comma, and the
 * last one is the same ID, so a joined value must never be stored.
 */
function findRequestId(body: any, headers: Headers): unknown {
  const header = headers.get("x-request-id")?.split(",").pop()?.trim()
  return body.x_0g_trace?.request_id ?? body.request_id ?? header ?? body.id
}

/**
 * Shares one key's request limit between all the agents, so they take turns and never hit it.
 * If the limit is hit anyway, every agent waits for as long as the router asks, and nobody sees a failure.
 */
export class PacedBrain implements Brain {
  private nextSlot = 0

  constructor(
    private readonly inner: Brain,
    private readonly gapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async next(messages: readonly Message[], tools: readonly ToolSpec[], signal?: AbortSignal): Promise<BrainReply> {
    for (let attempt = 1; ; attempt++) {
      const at = Math.max(this.now(), this.nextSlot)
      this.nextSlot = at + this.gapMs
      if (at > this.now()) await this.sleep(at - this.now())
      try {
        return await this.inner.next(messages, tools, signal)
      } catch (e) {
        if (!(e instanceof BrainBusy) || attempt >= MAX_BUSY_RETRIES) throw e
        this.nextSlot = Math.max(this.nextSlot, this.now() + e.retryAfterMs)
      }
    }
  }
}

/** The demo agents' model, reached through 0G's router. */
export class ZeroGBrain implements Brain {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async next(messages: readonly Message[], tools: readonly ToolSpec[], signal?: AbortSignal): Promise<BrainReply> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(`${ROUTER}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          // Each step is a small choice. With reasoning on, a step took up to 18 s.
          reasoning_effort: "none",
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      throw new BrainUnavailable(`0G unreachable: ${(e as Error).message}`)
    }

    const text = await res.text().catch(() => "")
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"))
      throw new BrainBusy(`0G returned 429: ${text.slice(0, 200)}`, (seconds > 0 ? seconds : DEFAULT_RETRY_S) * 1000)
    }
    if (!res.ok) throw new BrainUnavailable(`0G returned ${res.status}: ${text.slice(0, 200)}`)

    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new BrainUnavailable("0G returned something that is not JSON")
    }
    const message = body?.choices?.[0]?.message
    if (!message) throw new BrainUnavailable("0G returned no answer")

    const requestId = findRequestId(body, res.headers)
    if (typeof requestId !== "string" || requestId === "") throw new BrainUnavailable("0G returned no request ID")

    return {
      message: { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls },
      requestId,
      model: body.model ?? this.model,
      source: "0g",
    }
  }
}

/**
 * Local development only, and never a fallback: it runs only when explicitly turned on at start-up, and
 * everything it decides is labelled as coming from it.
 */
export class DevBrain implements Brain {
  private count = 0

  async next(messages: readonly Message[]): Promise<BrainReply> {
    const reply = (message: Omit<Message, "role">): BrainReply => ({
      message: { role: "assistant", ...message },
      requestId: `dev-${++this.count}`,
      model: "dev-rules",
      source: "dev",
    })
    const call = (name: string, args: unknown) =>
      reply({
        content: null,
        tool_calls: [{ id: `call-${this.count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      })

    const job = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
    const id = job.match(/INV-\d+/)?.[0] ?? "INV-0"
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content ?? "")
    if (results.length === 0) return call("read_invoice", { id })

    const invoice = JSON.parse(results[0]!) as { customerEmail: string; amount: string }
    const email = { to: invoice.customerEmail, subject: `Invoice ${id}`, body: `Your invoice ${id} for ${invoice.amount}.` }
    const last = results[results.length - 1]!
    if (results.length === 1) return call("send_email", email)
    if (/CeaseNet|Nobody|human/.test(last) && results.length === 2) return call("save_draft", email)
    return reply({ content: results.length === 2 ? `Sent ${id}.` : `Saved ${id} as a draft for a person.` })
  }
}
