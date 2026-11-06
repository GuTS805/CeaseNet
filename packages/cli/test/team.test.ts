import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type GateView, type LoadedFile, identityFiles, memoryStore, PRODUCTION_TIMERS, type RecallRow, teamArtifact, teamFile, type TrustPolicy } from "@ceasenet/core"
import { Guard, type GuardNet } from "@ceasenet/guard"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BrainBusy, BrainUnavailable } from "@ceasenet/demo/brain"
import { isBadToolCall, type JobHandle, TeamAgent } from "../src/agentRun"
import { type AgentEvent, type AgentState, chooseThinking, memberMcpSettings, prepareTools, TEAM, TOOLS } from "../src/fleet"
import { createMemberHome, initHome, loadConfig, loadKeys } from "../src/home"
import { packageProblem } from "../src/resolve"
import { importSettings, readSettings, saveSetting, settingsPath } from "../src/settings"

const OWNER = "0x00000000000000000000000000000000000000ff"
const AGENT = "0x00000000000000000000000000000000000000ee"
const policy: TrustPolicy = { issuers: [OWNER], regulators: [], verifier: OWNER, threshold: 3 }
const FILES: LoadedFile = { kind: "tool", name: "server-filesystem", version: "2.2.0", hash: "0xf11e" }
const MEMORY: LoadedFile = { kind: "tool", name: "server-memory", version: "2.1.0", hash: "0xa1" }

const stopOn = (artifact: string, reason = "It is doing harm", key = "0x01"): RecallRow => ({
  key: key as RecallRow["key"],
  artifact,
  level: "STOP",
  severity: "HIGH",
  reason,
  contentHash: "0xc",
  creator: OWNER,
  createdAt: 5n,
  expiresAt: 7_000_000n,
})

interface Harness {
  agent: TeamAgent
  guard: Guard
  net: GuardNet & { view: Partial<GateView>; down: boolean; acks: unknown[]; beats: string[]; slowAck?: Promise<void> }
  states: AgentState[]
  events: AgentEvent[]
  jobs: { prompt: string; killed: boolean; finish: (r: { ok: boolean; text: string }) => void }[]
  exits: number[]
  unwatched: { ms: number }
  last: () => AgentState
  /** Lets everything waiting on the loop move on. */
  settle: () => Promise<void>
}

function harness(tools: LoadedFile[] = [FILES, MEMORY]): Harness {
  const member = TEAM[0]!
  const net: Harness["net"] = {
    view: {},
    down: false,
    acks: [],
    beats: [],
    readView: async () => {
      if (net.down) throw new Error("no network")
      return { block: 10n, stops: [], advisories: [], endorsements: [], lifts: [], ...net.view }
    },
    writeLoadout: async () => undefined,
    writeHeartbeat: async (status) => void net.beats.push(status),
    writeAck: async (intent) => {
      await net.slowAck
      net.acks.push(intent.recall.key)
    },
    extendRecall: async () => undefined,
  }
  const guard = new Guard({
    policy,
    timers: { ...PRODUCTION_TIMERS, checkIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
    store: memoryStore(),
    files: [...tools, ...identityFiles(AGENT, OWNER), teamFile(OWNER)],
    net,
    startSeq: 1n,
  })
  const states: AgentState[] = []
  const events: AgentEvent[] = []
  const jobs: Harness["jobs"] = []
  const exits: number[] = []
  const unwatched = { ms: 0 }
  const agent = new TeamAgent({
    member,
    address: AGENT,
    tools,
    guard,
    startJob: (prompt): JobHandle => {
      let finish: (r: { ok: boolean; text: string }) => void = () => undefined
      const done = new Promise<{ ok: boolean; text: string }>((r) => (finish = r))
      const job = { prompt, killed: false, finish }
      jobs.push(job)
      return {
        done,
        kill: () => {
          job.killed = true
          finish({ ok: false, text: "killed" })
        },
      }
    },
    taskPath: (f) => `/inbox/${f}`,
    resultPath: (n) => `/outbox/${n}.txt`,
    unwatchedForMs: () => unwatched.ms,
    readInfo: () => ({ block: "10", tookMs: 3, stopsRead: 0 }),
    write: (s) => states.push(JSON.parse(JSON.stringify(s)) as AgentState),
    event: (e) => events.push(e),
    exit: (code) => exits.push(code),
    // Short waits pass at once. The limit on waiting for a receipt is a long one, and never runs out here.
    wait: (ms) => (ms >= 45_000 ? new Promise(() => undefined) : new Promise((r) => setImmediate(r))),
    jobGapMs: 1,
  })
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
  }
  return { agent, guard, net, states, events, jobs, exits, unwatched, last: () => states[states.length - 1]!, settle }
}

describe("an agent, before it starts", () => {
  it("reads the list first, and starts a job only once nothing covers it", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    expect(h.last().checks).toBeGreaterThan(0)
    expect(h.jobs).toHaveLength(1)
    expect(h.events[0]!.text).toContain("Read the recall list")
  })

  it("refuses to start under a recall, and never runs a job", async () => {
    const h = harness()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.agent.start()
    await h.settle()
    expect(h.jobs).toHaveLength(0)
    expect(h.last().phase).toBe("closed")
    expect(h.last().closed?.afterStart).toBe(false)
    expect(h.exits).toEqual([0])
  })
})

describe("an agent that is working, when a recall arrives", () => {
  it("closes when a tool it uses is recalled, killing the job it was doing", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash, "It reads files it should not")] }
    await h.guard.check(true)
    await h.settle()
    expect(h.jobs[0]!.killed).toBe(true)
    expect(h.last().phase).toBe("closed")
    expect(h.last().closed).toMatchObject({ reason: "It reads files it should not", tool: "server-filesystem", afterStart: true })
    expect(h.exits).toEqual([0])
  })

  it("closes when it is stopped by name", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(`agent:${AGENT}`)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.last().phase).toBe("closed")
    expect(h.last().closed?.tool).toBeUndefined()
  })

  it("closes when its team is stopped", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(teamArtifact(OWNER))] }
    await h.guard.check(true)
    await h.settle()
    expect(h.last().phase).toBe("closed")
  })

  it("keeps working when the recall is about something it does not use", async () => {
    const h = harness([MEMORY])
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.exits).toEqual([])
    expect(h.jobs[0]!.killed).toBe(false)
  })

  it("keeps working when the recall comes from a key nobody follows", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [{ ...stopOn(`agent:${AGENT}`), creator: "0x00000000000000000000000000000000000000dd" }] }
    await h.guard.check(true)
    await h.settle()
    expect(h.exits).toEqual([])
  })

  it("posts its receipt before it leaves, however slow that is", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    let release: () => void = () => undefined
    h.net.slowAck = new Promise((r) => (release = r))
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.exits).toEqual([])
    release()
    await h.settle()
    expect(h.net.acks).toEqual(["0x01"])
    expect(h.exits).toEqual([0])
  })

  it("says it has stopped in its last heartbeat, even for one tool's recall", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.net.beats[h.net.beats.length - 1]).toBe("STOPPED")
  })

  it("does not take the model's word for anything: it closes whatever the job says", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    h.jobs[0]!.finish({ ok: true, text: "I finished, and I would like to carry on." })
    await h.settle()
    expect(h.last().phase).toBe("closed")
    expect(h.last().jobs).toBe(0)
  })

  it("closes only once, however many checks see the recall", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.guard.check(true)
    await h.settle()
    expect(h.exits).toEqual([0])
    expect(h.events.filter((e) => e.kind === "closed")).toHaveLength(1)
  })
})

describe("an agent, doing its work", () => {
  it("counts finished jobs, keeps what the model said, and starts the next", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.jobs[0]!.finish({ ok: true, text: "Drafted the reminder." })
    await h.settle()
    expect(h.states.some((s) => s.jobs === 1 && s.lastSaid === "Drafted the reminder.")).toBe(true)
    expect(h.jobs).toHaveLength(2)
    expect(h.jobs[1]!.prompt).toContain("Job 2")
  })

  it("moves through its tasks", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    expect(h.jobs[0]!.prompt).toContain(TEAM[0]!.tasks[0]!.file)
    h.jobs[0]!.finish({ ok: true, text: "Done." })
    await h.settle()
    expect(h.jobs[1]!.prompt).toContain(TEAM[0]!.tasks[1]!.file)
  })

  it("says so when the model cannot be reached, rather than making anything up", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.jobs[0]!.finish({ ok: false, text: "Cannot reach the model" })
    await h.settle()
    expect(h.states.some((s) => s.phase === "waiting" && s.problem === "Cannot reach the model")).toBe(true)
    expect(h.states.every((s) => s.jobs === 0)).toBe(true)
  })

  it("starts nothing new with nobody watching, and keeps reading the list", async () => {
    const h = harness()
    h.unwatched.ms = 3 * 60_000
    void h.agent.start()
    await h.settle()
    expect(h.jobs).toHaveLength(0)
    expect(h.last().phase).toBe("paused")
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.last().phase).toBe("closed")
  })

  it("shuts itself down after nobody has looked for a long time", async () => {
    const h = harness()
    h.unwatched.ms = 60 * 60_000
    await h.agent.start()
    expect(h.last().phase).toBe("off")
    expect(h.exits).toEqual([0])
    expect(h.last().closed).toBeUndefined()
  })
})

describe("an agent whose model has reached a limit", () => {
  it("says so, and tries the same job again rather than skipping ahead", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    expect(h.jobs[0]!.prompt).toContain("Job 1")
    h.jobs[0]!.finish({ ok: false, text: "Today's allowance is used up." })
    await h.settle()
    expect(h.states.some((s) => s.phase === "waiting" && s.problem === "Today's allowance is used up.")).toBe(true)
    expect(h.jobs[1]!.prompt).toContain("Job 1")
  })

  it("does not repeat the same complaint on every try", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.jobs[0]!.finish({ ok: false, text: "Today's allowance is used up." })
    await h.settle()
    h.jobs[1]!.finish({ ok: false, text: "Today's allowance is used up." })
    await h.settle()
    expect(h.events.filter((e) => e.kind === "problem")).toHaveLength(1)
  })

  it("still closes at once while it waits", async () => {
    const h = harness()
    void h.agent.start()
    await h.settle()
    h.jobs[0]!.finish({ ok: false, text: "Today's allowance is used up." })
    await h.settle()
    h.net.view = { stops: [stopOn(FILES.hash)] }
    await h.guard.check(true)
    await h.settle()
    expect(h.last().phase).toBe("closed")
    expect(h.exits).toEqual([0])
  })
})

describe("an agent cut off from the list", () => {
  it("starts no new job while it cannot read it, and closes once that has gone on too long", async () => {
    const clock = { t: 1_000_000 }
    const h = harness()
    const net = h.net
    const guard = new Guard({
      policy,
      timers: { ...PRODUCTION_TIMERS, checkIntervalMs: 60_000, graceMs: 100, offlineSupervisedMs: 100 },
      store: memoryStore(),
      files: [FILES, ...identityFiles(AGENT, OWNER)],
      net,
      startSeq: 1n,
      now: () => clock.t,
    })
    const exits: number[] = []
    const states: AgentState[] = []
    const agent = new TeamAgent({
      member: TEAM[0]!,
      address: AGENT,
      tools: [FILES],
      guard,
      startJob: () => ({ done: new Promise(() => undefined), kill: () => undefined }),
      taskPath: (f) => f,
      resultPath: (n) => String(n),
      unwatchedForMs: () => 0,
      readInfo: () => ({ block: "1", tookMs: 1, stopsRead: 0 }),
      write: (s) => states.push(JSON.parse(JSON.stringify(s)) as AgentState),
      event: () => undefined,
      exit: (c) => exits.push(c),
      wait: (ms) => (ms >= 45_000 ? new Promise(() => undefined) : new Promise((r) => setImmediate(r))),
    })
    void agent.start()
    await h.settle()
    net.down = true
    clock.t += 1_000
    await guard.check(true)
    await h.settle()
    expect(exits).toEqual([0])
    expect(states[states.length - 1]!.closed?.reason).toContain("could not read the recall list")
  })
})

describe("the team", () => {
  it("has three agents, and every one reads the market, so recalling that closes them all", () => {
    expect(TEAM).toHaveLength(3)
    expect(TEAM.every((m) => m.tools.includes("market"))).toBe(true)
  })

  it("has one agent that never trades, so recalling the broker closes only two", () => {
    expect(TEAM.filter((m) => m.tools.includes("broker")).map((m) => m.id)).toEqual(["momentum", "reversion"])
  })

  it("names the market in every job, and tells the traders when to trade", () => {
    const [momentum, reversion, risk] = TEAM
    expect(momentum!.job({ task: "BTC-USD", result: "", n: 1 })).toContain("BTC-USD")
    expect(momentum!.job({ task: "BTC-USD", result: "", n: 1 })).toMatch(/rose by more than 0\.1%.*buy/)
    expect(reversion!.job({ task: "BTC-USD", result: "", n: 1 })).toMatch(/fell by more than 0\.1%.*buy/)
    expect(risk!.job({ task: "BTC-USD", result: "", n: 1 })).not.toContain("buy")
  })

  it("puts each agent's account in its own folder, and every tool behind the gate", () => {
    const self = { command: "node", args: ["ceasenet.mjs"] }
    const settings = memberMcpSettings(TEAM[0]!, "/home/team/momentum", "/home", self) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> }
    const { broker, market } = settings.mcpServers
    expect(broker!.args).toContain("run")
    expect(market!.args).toContain("run")
    expect(broker!.args).toContain("--package")
    expect(broker!.args).toContain(join("/home/team/momentum", "workspace", "book.json"))
    expect(broker!.args).toContain(join("/home/team/momentum", "workspace", "outbox"))
  })

  it("gives the risk watcher no broker at all", () => {
    const self = { command: "node", args: ["ceasenet.mjs"] }
    const settings = memberMcpSettings(TEAM[2]!, "/h", "/m", self) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(settings.mcpServers)).toEqual(["market"])
  })

  it("does not put any model or service key in what a server can see", () => {
    const self = { command: "node", args: ["ceasenet.mjs"] }
    const settings = memberMcpSettings(TEAM[0]!, "/h", "/m", self) as { mcpServers: Record<string, { env: Record<string, string> }> }
    for (const server of Object.values(settings.mcpServers)) {
      expect(Object.keys(server.env).every((k) => k.startsWith("CEASENET_"))).toBe(true)
    }
  })

  it("only offers a model the calls its jobs need", () => {
    expect(TOOLS.market.calls).toEqual(["get_price", "get_candles"])
    expect(TOOLS.broker.calls).toEqual(["get_portfolio", "place_order"])
  })

  it("measures its tools from the packages it ships", () => {
    const tools = prepareTools()
    expect(tools.map((t) => [t.file.name, t.file.version])).toEqual([
      ["trade-market-tool", "1.0.0"],
      ["trade-broker-tool", "1.0.0"],
    ])
    expect(tools.every((t) => t.file.hash.startsWith("0x"))).toBe(true)
  })
})

describe("a model that writes a broken tool call", () => {
  const refusal = 'api.groq.com returned 400: {"error":{"message":"Failed to parse tool call arguments as JSON","code":"tool_use_failed"}}'

  it("is recognised, so the job is not thrown away", () => {
    expect(isBadToolCall(new BrainUnavailable(refusal))).toBe(true)
  })

  it("is not confused with the service being down or busy", () => {
    expect(isBadToolCall(new BrainUnavailable("api.groq.com unreachable: timeout"))).toBe(false)
    expect(isBadToolCall(new BrainBusy(refusal, 1000))).toBe(false)
    expect(isBadToolCall(new Error(refusal))).toBe(false)
  })
})

describe("settings", () => {
  let dir: string
  let previous: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ceasenet-settings-"))
    previous = process.env.CEASENET_HOME
    process.env.CEASENET_HOME = dir
    delete process.env.CEASENET_MAIN_HOME
    initHome({ name: "Test", network: "local", accessKey: "" })
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.CEASENET_HOME
    else process.env.CEASENET_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })

  const source = () => {
    const path = join(dir, "source.env")
    writeFileSync(path, 'DEMO_MNEMONIC="word word word"\nMODEL_API_KEY="the-key"\nMODEL_NAME="a-model"\nWORLD_APP_ID="app_1"\nARKIV_ACCESS_KEY="access"\nBEE_API_URL=""\nSOMETHING_ELSE="x"\n')
    return path
  }

  it("never copies a wallet's secret phrase", () => {
    const { imported, left } = importSettings(source())
    expect(left).toContain("DEMO_MNEMONIC")
    expect(imported).not.toContain("DEMO_MNEMONIC")
    expect(readFileSync(settingsPath(), "utf8")).not.toContain("word word")
    expect(readSettings().DEMO_MNEMONIC).toBeUndefined()
  })

  it("copies only what it knows about, and skips what is empty", () => {
    const { imported, left } = importSettings(source())
    expect(imported.sort()).toEqual(["ARKIV_ACCESS_KEY", "MODEL_API_KEY", "MODEL_NAME", "WORLD_APP_ID"])
    expect(left).toContain("SOMETHING_ELSE")
    expect(readSettings().MODEL_API_KEY).toBe("the-key")
    expect(readSettings().BEE_API_URL).toBeUndefined()
  })

  it("says what moved by name, and the result holds no value it was not given", () => {
    expect(importSettings(source()).imported.join()).not.toContain("the-key")
  })

  it("does not put settings in the environment, where a tool could see them", () => {
    importSettings(source())
    readSettings()
    expect(process.env.MODEL_API_KEY === "the-key").toBe(false)
  })

  it("uses the access key straight away", () => {
    importSettings(source())
    expect(loadConfig().accessKey).toBe("access")
  })

  it("keeps earlier settings when more are added", () => {
    importSettings(source())
    const more = join(dir, "more.env")
    writeFileSync(more, 'SWARM_POSTAGE_BATCH_ID="batch"\n')
    importSettings(more)
    expect(readSettings()).toMatchObject({ MODEL_API_KEY: "the-key", SWARM_POSTAGE_BATCH_ID: "batch" })
  })

  it("explains a file that is not there", () => {
    expect(() => importSettings(join(dir, "none.env"))).toThrow(/no file/)
  })

  it("thinks with a model key when there is one, and names no key", () => {
    const thinking = chooseThinking({ MODEL_API_KEY: "the-key", MODEL_NAME: "a-model", MODEL_API_URL: "https://api.example.com/v1" })
    expect(thinking).toEqual({ kind: "api", model: "a-model", host: "api.example.com", requestsPerMinute: 16 })
    expect(JSON.stringify(thinking)).not.toContain("the-key")
  })

  it("thinks with the model chosen at the console, over the one in the file", () => {
    const thinking = chooseThinking({ MODEL_API_KEY: "k", MODEL_NAME: "a-model", MODEL_API_URL: "https://api.example.com/v1", AGENT_THINKING: "another-model" })
    expect(thinking).toMatchObject({ kind: "api", model: "another-model" })
  })

  it("keeps a choice made at the console, along with everything else", () => {
    importSettings(source())
    saveSetting("AGENT_THINKING", "another-model")
    expect(readSettings()).toMatchObject({ AGENT_THINKING: "another-model", MODEL_API_KEY: "the-key" })
  })
})

describe("a team member's home", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ceasenet-member-"))
    process.env.CEASENET_HOME = dir
  })
  afterEach(() => {
    delete process.env.CEASENET_HOME
    rmSync(dir, { recursive: true, force: true })
  })

  it("has its own key, the same owner and the same list, and never the owner's key", () => {
    const { config } = initHome({ name: "Main", network: "local", accessKey: "" })
    const made = createMemberHome(join(dir, "m"), { name: "One" }, config)
    expect(made.owner.address).toBe(config.owner.address)
    expect(made.agent.address).not.toBe(config.agent.address)
    expect(made.ledgerFile).toBe(join(dir, "ledger.jsonl"))
    expect(made.team).toBe(true)
    const keys = JSON.parse(readFileSync(join(dir, "m", "keys.json"), "utf8")) as { agent: string; owner?: string }
    expect(keys.owner).toBeUndefined()
    expect(keys.agent).not.toBe(loadKeys().agent)
  })

  it("keeps its identity when made again, and follows the owner to a new list", () => {
    const { config } = initHome({ name: "Main", network: "local", accessKey: "" })
    const first = createMemberHome(join(dir, "m"), { name: "One" }, config)
    const second = createMemberHome(join(dir, "m"), { name: "One" }, { ...config, network: "arkiv", accessKey: "k" })
    expect(second.agent.address).toBe(first.agent.address)
    expect(second.network).toBe("arkiv")
    expect(second.accessKey).toBe("k")
  })
})

describe("whether a pinned package is still what was installed", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ceasenet-pin-"))
    mkdirSync(join(dir, "dist"))
    writeFileSync(join(dir, "package.json"), '{"name":"x","version":"1.0.0"}')
    writeFileSync(join(dir, "dist", "index.js"), "console.log(1)")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const installedNow = async () => {
    const { hashBytes } = await import("@ceasenet/core")
    const { readPackage } = await import("@ceasenet/guard")
    return Object.fromEntries(readPackage(dir).map((f) => [f.path, hashBytes(f.content)]))
  }

  it("is fine when nothing has changed", async () => {
    expect(packageProblem(dir, await installedNow())).toBeUndefined()
  })

  it("allows a tool to keep data beside itself, as the official memory server does", async () => {
    const installed = await installedNow()
    writeFileSync(join(dir, "dist", "memory.jsonl"), '{"data":1}')
    expect(packageProblem(dir, installed)).toBeUndefined()
  })

  it("notices when code changes", async () => {
    const installed = await installedNow()
    writeFileSync(join(dir, "dist", "index.js"), "console.log('stolen')")
    expect(packageProblem(dir, installed)).toContain("index.js changed")
  })

  it("notices when code is added", async () => {
    const installed = await installedNow()
    writeFileSync(join(dir, "dist", "extra.js"), "console.log('stolen')")
    expect(packageProblem(dir, installed)).toContain("extra.js was added")
  })

  it("notices when a file is removed", async () => {
    const installed = await installedNow()
    rmSync(join(dir, "dist", "index.js"))
    expect(packageProblem(dir, installed)).toContain("index.js was removed")
  })
})
