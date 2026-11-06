import { describe, expect, it } from "vitest"
import { type Brain, BrainBusy, type BrainReply, BrainUnavailable, ModelBrain, modelFromEnv, modelHost, type ModelSettings, PacedBrain } from "../src/brain"

const SETTINGS: Omit<ModelSettings, "requestsPerMinute"> = { url: "https://model.example/v1", apiKey: "k", model: "m" }
const modelWith = (f: typeof fetch, over: Partial<ModelSettings> = {}) => new ModelBrain({ ...SETTINGS, ...over }, f)

const REPLY: BrainReply = { message: { role: "assistant", content: "ok" }, requestId: "r", model: "m", source: "dev" }

/** A clock that moves only when something sleeps, so the timing is exact. */
function paced(inner: Brain, gapMs = 2000) {
  let clock = 1_000_000
  const sleeps: number[] = []
  const calledAt: number[] = []
  const counted: Brain = {
    next: (...a) => {
      calledAt.push(clock)
      return inner.next(...a)
    },
  }
  const brain = new PacedBrain(counted, gapMs, () => clock, async (ms) => {
    sleeps.push(ms)
    clock += ms
  })
  return { brain, sleeps, calledAt, start: 1_000_000 }
}

const fine: Brain = { next: async () => REPLY }

describe("PacedBrain", () => {
  it("spaces requests out, one after another", async () => {
    const p = paced(fine)
    await p.brain.next([], [])
    await p.brain.next([], [])
    await p.brain.next([], [])
    expect(p.calledAt.map((t) => t - p.start)).toEqual([0, 2000, 4000])
  })

  it("makes several agents take turns when they ask at once", async () => {
    const p = paced(fine)
    await Promise.all([p.brain.next([], []), p.brain.next([], []), p.brain.next([], [])])
    // The second waits one gap and the third waits two: the clock has already moved on by one when it asks.
    expect(p.sleeps).toEqual([2000, 2000])
    expect(p.calledAt).toHaveLength(3)
  })

  it("does not wait when there has been a long gap", async () => {
    let clock = 0
    const sleeps: number[] = []
    const brain = new PacedBrain(fine, 2000, () => clock, async (ms) => void sleeps.push(ms))
    await brain.next([], [])
    clock = 60_000
    await brain.next([], [])
    expect(sleeps).toEqual([])
  })

  it("waits as long as the router asks, and the caller never sees it", async () => {
    let calls = 0
    const busyOnce: Brain = {
      next: async () => {
        if (++calls === 1) throw new BrainBusy("429", 43_000)
        return REPLY
      },
    }
    const p = paced(busyOnce)
    expect(await p.brain.next([], [])).toBe(REPLY)
    expect(p.calledAt[1]! - p.calledAt[0]!).toBe(43_000)
  })

  it("holds back the other agents during that wait too", async () => {
    let calls = 0
    const busyOnce: Brain = {
      next: async () => {
        if (++calls === 1) throw new BrainBusy("429", 43_000)
        return REPLY
      },
    }
    const p = paced(busyOnce)
    await p.brain.next([], [])
    await p.brain.next([], [])
    expect(p.calledAt[2]! - p.calledAt[0]!).toBe(45_000)
  })

  it("gives up in the end, and the agent then shows the model as unavailable", async () => {
    const always: Brain = {
      next: async () => {
        throw new BrainBusy("429", 1000)
      },
    }
    await expect(paced(always).brain.next([], [])).rejects.toBeInstanceOf(BrainUnavailable)
  })

  it("speaks up instead of waiting out a long limit, such as a daily one", async () => {
    let calls = 0
    const daily: Brain = {
      next: async () => {
        calls++
        throw new BrainBusy("429", 3_600_000)
      },
    }
    await expect(paced(daily).brain.next([], [])).rejects.toBeInstanceOf(BrainUnavailable)
    expect(calls).toBe(1)
  })

  it("does not retry any other failure", async () => {
    let calls = 0
    const down: Brain = {
      next: async () => {
        calls++
        throw new BrainUnavailable("down")
      },
    }
    await expect(paced(down).brain.next([], [])).rejects.toThrow("down")
    expect(calls).toBe(1)
  })
})

describe("modelFromEnv", () => {
  it("explains what is missing", () => {
    expect(() => modelFromEnv({})).toThrow("MODEL_API_KEY is missing")
  })

  it("never picks up another service's key", () => {
    expect(() => modelFromEnv({ ZG_API_KEY: "sk-old" })).toThrow("MODEL_API_KEY is missing")
  })

  it("has working defaults, and takes any service", () => {
    expect(modelFromEnv({ MODEL_API_KEY: "k" }).url).toContain("groq.com")
    const custom = modelFromEnv({ MODEL_API_KEY: "k", MODEL_API_URL: "http://localhost:11434/v1", MODEL_NAME: "mine", MODEL_REQUESTS_PER_MINUTE: "90", MODEL_REASONING_EFFORT: "none" })
    expect(custom).toEqual({ url: "http://localhost:11434/v1", apiKey: "k", model: "mine", requestsPerMinute: 90, reasoningEffort: "none" })
    expect(modelHost(custom.url)).toBe("localhost:11434")
  })
})

describe("ModelBrain", () => {
  it("names the service in its errors, and never the key", async () => {
    const error = await modelWith((async () => new Response("no", { status: 500 })) as typeof fetch, { apiKey: "sk-secret" }).next([], []).catch((e) => e)
    expect(error.message).toContain("model.example")
    expect(error.message).not.toContain("sk-secret")
  })

  const respond = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify({ error: { message: "Rate limit exceeded." } }), { status, headers })) as typeof fetch

  it("reads how long a rate limit lasts", async () => {
    const brain = modelWith(respond(429, { "retry-after": "43" }))
    const error = await brain.next([], []).catch((e) => e)
    expect(error).toBeInstanceOf(BrainBusy)
    expect(error.retryAfterMs).toBe(43_000)
  })

  it("waits a little when the router does not say how long", async () => {
    const error = await modelWith(respond(429)).next([], []).catch((e) => e)
    expect(error.retryAfterMs).toBe(10_000)
  })

  it("does not treat other failures as a rate limit", async () => {
    const error = await modelWith(respond(500)).next([], []).catch((e) => e)
    expect(error).toBeInstanceOf(BrainUnavailable)
    expect(error).not.toBeInstanceOf(BrainBusy)
  })
})
