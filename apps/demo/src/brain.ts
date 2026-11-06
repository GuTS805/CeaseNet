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
  source: "model" | "dev"
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

/** Used when the router says it is busy without saying for how long. */
const DEFAULT_RETRY_S = 10
const MAX_BUSY_RETRIES = 5
/** Longer than this is a daily limit or similar. The agent says so, instead of sitting there in silence. */
const MAX_BUSY_WAIT_MS = 90_000
/** Enough for one tool call or a short sentence. It also keeps token limits from being reserved for nothing. */
const MAX_REPLY_TOKENS = 400
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
        if (!(e instanceof BrainBusy) || attempt >= MAX_BUSY_RETRIES || e.retryAfterMs > MAX_BUSY_WAIT_MS) throw e
        this.nextSlot = Math.max(this.nextSlot, this.now() + e.retryAfterMs)
      }
    }
  }
}

export interface ModelSettings {
  /** Any service that speaks the OpenAI chat API and supports tool calling, including one you run yourself. */
  url: string
  apiKey: string
  model: string
  /** Some models spend many seconds reasoning unless told not to. Others refuse the setting, so it is opt-in. */
  reasoningEffort?: string
  requestsPerMinute: number
}

const DEFAULT_URL = "https://api.groq.com/openai/v1"
const DEFAULT_MODEL = "openai/gpt-oss-20b"
/** Groq's free tier allows 8,000 tokens a minute, and one step of this demo uses about 470. */
const DEFAULT_REQUESTS_PER_MINUTE = 16

/** Reads the model's settings, or explains what is missing. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const apiKey = env.MODEL_API_KEY
  if (!apiKey) throw new Error("MODEL_API_KEY is missing. Add it to .env, or use npm run demo:dev for local development only.")
  return {
    url: env.MODEL_API_URL || DEFAULT_URL,
    apiKey,
    model: env.MODEL_NAME || DEFAULT_MODEL,
    reasoningEffort: env.MODEL_REASONING_EFFORT || undefined,
    requestsPerMinute: Number(env.MODEL_REQUESTS_PER_MINUTE) || DEFAULT_REQUESTS_PER_MINUTE,
  }
}

/** Who answers. Shown to people, and never includes the key. */
export const modelHost = (url: string): string => new URL(url).host

/** The demo agents' model. */
export class ModelBrain implements Brain {
  private readonly url: string
  private readonly host: string

  constructor(
    private readonly settings: Omit<ModelSettings, "requestsPerMinute">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.url = settings.url.replace(/\/+$/, "")
    this.host = modelHost(settings.url)
  }

  async next(messages: readonly Message[], tools: readonly ToolSpec[], signal?: AbortSignal): Promise<BrainReply> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.apiKey}` },
        body: JSON.stringify({
          model: this.settings.model,
          temperature: 0,
          max_tokens: MAX_REPLY_TOKENS,
          ...(this.settings.reasoningEffort ? { reasoning_effort: this.settings.reasoningEffort } : {}),
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      throw new BrainUnavailable(`${this.host} unreachable: ${(e as Error).message}`)
    }

    const text = await res.text().catch(() => "")
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"))
      throw new BrainBusy(`${this.host} returned 429: ${text.slice(0, 200)}`, (seconds > 0 ? seconds : DEFAULT_RETRY_S) * 1000)
    }
    if (!res.ok) throw new BrainUnavailable(`${this.host} returned ${res.status}: ${text.slice(0, 200)}`)

    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new BrainUnavailable(`${this.host} returned something that is not JSON`)
    }
    const message = body?.choices?.[0]?.message
    if (!message) throw new BrainUnavailable(`${this.host} returned no answer`)

    const requestId = findRequestId(body, res.headers)
    if (typeof requestId !== "string" || requestId === "") throw new BrainUnavailable(`${this.host} returned no request ID`)

    return {
      message: { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls },
      requestId,
      model: body.model ?? this.settings.model,
      source: "model",
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
