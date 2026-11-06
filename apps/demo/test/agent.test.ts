import { type GateView, type LoadedFile, memoryStore, type RecallRow, type TrustPolicy } from "@ceasenet/core"
import { Guard, type GuardNet } from "@ceasenet/guard"
import { describe, expect, it } from "vitest"
import { OfficeAgent, type ToolConnection } from "../src/agent"
import { type Brain, BrainUnavailable, DevBrain, ZeroGBrain } from "../src/brain"
import type { ToolPackage } from "../src/catalog"

const MAKER = "0x00000000000000000000000000000000000000aa" as const
const policy: TrustPolicy = { issuers: [MAKER], regulators: [], verifier: "0x00000000000000000000000000000000000000cc", threshold: 3 }

const pkg = (name: string, version: string, hash: string): ToolPackage => ({ file: { kind: "tool", name, version, hash }, dir: "" })
const BAD = pkg("demo-mail-tool", "1.0.16", "0xbad")
const GOOD = pkg("demo-mail-tool", "1.0.17", "0xfeed")
const FILES = pkg("demo-files-tool", "2.1.0", "0xf11e")

const STOP: RecallRow = {
  key: "0x01",
  artifact: BAD.file.hash,
  level: "STOP",
  severity: "HIGH",
  reason: "copies mail",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 5n,
  expiresAt: 7_000_000n,
}

class FakeNet implements GuardNet {
  view: Partial<GateView> = {}
  async readView(): Promise<GateView> {
    return { block: 10n, stops: [], advisories: [], endorsements: [], lifts: [], ...this.view }
  }
  async writeLoadout() {}
  async writeHeartbeat() {}
  async writeAck() {}
  async extendRecall() {}
}

const SPECS: Record<string, string[]> = {
  "demo-mail-tool": ["send_email"],
  "demo-files-tool": ["read_invoice", "save_draft"],
}

function make(brain: Brain = new DevBrain(), over: { model?: LoadedFile } = {}) {
  const net = new FakeNet()
  const clock = { t: 0 }
  const reached: string[] = []
  const closed: string[] = []
  const files = [BAD.file, FILES.file, ...(over.model ? [over.model] : [])]
  const guard = new Guard({
    policy,
    timers: { checkIntervalMs: 100, heartbeatIntervalMs: 100, heartbeatTtlSeconds: 10, graceMs: 1000, offlineSupervisedMs: 1000 },
    store: memoryStore(),
    files,
    net,
    startSeq: 1n,
    now: () => (clock.t += 2000),
  })
  const connect = async (p: ToolPackage): Promise<ToolConnection> => ({
    file: p.file,
    specs: (SPECS[p.file.name] ?? []).map((name) => ({ name, description: "", inputSchema: {} })),
    // Goes through the real guard, as in the demo. Only the tool process itself is left out.
    call: async (name) => {
      const decision = await guard.beforeCall(p.file, name)
      if (!decision.allowed) return { ok: false, text: decision.message, decision }
      reached.push(`${p.file.version}:${name}`)
      const text = name === "read_invoice" ? JSON.stringify({ customerEmail: "a@example.com", amount: "1 INR" }) : "ok"
      return { ok: true, text, decision }
    },
    close: async () => {
      closed.push(p.file.version)
    },
  })
  const agent = new OfficeAgent({
    id: "a",
    company: "Test",
    guard,
    brain,
    systemPrompt: "p",
    tools: [BAD, FILES],
    connect,
    findFix: (hash) => (hash === GOOD.file.hash ? GOOD : undefined),
    autoUpdate: true,
    wait: async () => undefined,
  })
  return { agent, guard, net, reached, closed }
}

const prepare = async (m: ReturnType<typeof make>) => {
  m.agent.connections = await Promise.all([BAD, FILES].map((t) => m.agent.opts.connect(t)))
  await m.guard.start()
  ;(m.agent as any).running = true
}

describe("OfficeAgent", () => {
  it("does the job: reads the invoice, then sends the email", async () => {
    const m = make()
    await prepare(m)
    await m.agent.runJob()
    expect(m.reached).toEqual(["2.1.0:read_invoice", "1.0.16:send_email"])
    expect(m.agent.jobs).toBe(1)
  })

  it("never reaches a recalled tool, and carries on with the others", async () => {
    const m = make()
    await prepare(m)
    m.net.view = { stops: [STOP] }
    await m.guard.check(true)
    await m.agent.runJob()
    expect(m.reached).toEqual(["2.1.0:read_invoice", "2.1.0:save_draft"])
    expect(m.reached.some((r) => r.includes("send_email"))).toBe(false)
    expect(m.agent.feed.some((f) => f.kind === "blocked" && f.text.includes("demo-mail-tool 1.0.16"))).toBe(true)
    expect(m.agent.jobs).toBe(1)
  })

  it("tells the model why the tool was refused", async () => {
    const seen: string[] = []
    const inner = new DevBrain()
    const brain: Brain = {
      next: async (messages, tools) => {
        seen.push(...messages.filter((x) => x.role === "tool").map((x) => x.content ?? ""))
        return inner.next(messages)
      },
    }
    const m = make(brain)
    await prepare(m)
    m.net.view = { stops: [STOP] }
    await m.guard.check(true)
    await m.agent.runJob()
    expect(seen.some((s) => s.includes("copies mail"))).toBe(true)
  })

  it("does nothing at all when the agent itself is stopped", async () => {
    const model: LoadedFile = { kind: "model", name: "glm", version: "1", hash: "0xa1" }
    const m = make(new DevBrain(), { model })
    await prepare(m)
    m.net.view = { stops: [{ ...STOP, artifact: model.hash }] }
    await m.guard.check(true)
    await m.agent.runJob()
    expect(m.reached).toEqual([])
  })

  it("waits rather than guesses when the model cannot be reached", async () => {
    let calls = 0
    const inner = new DevBrain()
    const brain: Brain = {
      next: async (messages) => {
        calls++
        if (calls <= 2) throw new BrainUnavailable("down")
        return inner.next(messages)
      },
    }
    const m = make(brain)
    await prepare(m)
    const pausedDuring: boolean[] = []
    ;(m.agent as any).wait = async () => {
      pausedDuring.push(m.guard.status === "PAUSED")
    }
    await m.agent.runJob()
    expect(pausedDuring).toEqual([true, true])
    expect(m.guard.status).toBe("RUNNING")
    expect(m.agent.jobs).toBe(1)
  })

  it("moves to a published fix and uses the mail tool again", async () => {
    const m = make()
    await prepare(m)
    m.net.view = {
      stops: [STOP],
      lifts: [{ key: "0x03", recall: STOP.key, artifact: BAD.file.hash, kind: "FIX", fixedHash: GOOD.file.hash, creator: MAKER, createdAt: 8n }],
    }
    await m.guard.check(true)
    expect(await m.agent.installFix()).toBe(true)
    expect(m.closed).toEqual(["1.0.16"])
    await m.agent.runJob()
    expect(m.reached).toContain("1.0.17:send_email")
  })

  it("does not install a fix it cannot find", async () => {
    const m = make()
    await prepare(m)
    m.net.view = {
      stops: [STOP],
      lifts: [{ key: "0x03", recall: STOP.key, artifact: BAD.file.hash, kind: "FIX", fixedHash: "0xunknown", creator: MAKER, createdAt: 8n }],
    }
    await m.guard.check(true)
    expect(await m.agent.installFix()).toBe(false)
  })

  it("reports an unknown tool to the model rather than failing", async () => {
    const brain: Brain = {
      next: async (messages) =>
        messages.some((x) => x.role === "tool")
          ? { message: { role: "assistant", content: "done" }, requestId: "r", model: "m", source: "dev" }
          : {
              message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "launch_rocket", arguments: "{}" } }] },
              requestId: "r",
              model: "m",
              source: "dev",
            },
    }
    const m = make(brain)
    await prepare(m)
    await m.agent.runJob()
    expect(m.reached).toEqual([])
    expect(m.agent.jobs).toBe(1)
  })
})

describe("ZeroGBrain", () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch
  const answer = { choices: [{ message: { content: "ok" } }] }

  it("uses the ID 0G reports in its trace", async () => {
    const f = reply(200, { ...answer, id: "as-1", x_0g_trace: { request_id: "308254f5" } }, { "x-request-id": "bde4, 308254f5" })
    expect((await new ZeroGBrain("k", "m", f).next([], [])).requestId).toBe("308254f5")
  })

  it("never stores two joined IDs from the header", async () => {
    const f = reply(200, answer, { "x-request-id": "bde4, 308254f5" })
    expect((await new ZeroGBrain("k", "m", f).next([], [])).requestId).toBe("308254f5")
  })

  it("treats a reply with no request ID as unusable", async () => {
    await expect(new ZeroGBrain("k", "m", reply(200, answer)).next([], [])).rejects.toThrow(BrainUnavailable)
  })

  it("reports running out of funds and outages as unavailable", async () => {
    await expect(new ZeroGBrain("k", "m", reply(402, {})).next([], [])).rejects.toThrow(BrainUnavailable)
    await expect(new ZeroGBrain("k", "m", reply(503, {})).next([], [])).rejects.toThrow(BrainUnavailable)
    const boom = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await expect(new ZeroGBrain("k", "m", boom).next([], [])).rejects.toThrow(BrainUnavailable)
  })

  it("asks the model not to spend time reasoning, and offers the tools", async () => {
    let sent: any
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ ...answer, request_id: "r" }))
    }) as unknown as typeof fetch
    await new ZeroGBrain("k", "m", f).next([], [{ name: "send_email", description: "d", inputSchema: { type: "object" } }])
    expect(sent.reasoning_effort).toBe("none")
    expect(sent.tools[0].function.name).toBe("send_email")
  })
})
