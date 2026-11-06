import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { modelRunner } from "../src/agentRun"
import { mcpSettingsPath, startReport, TEAM, terminalScript, TOOLS, toolDir } from "../src/fleet"

/** Stands in for the market data service, so these tests can move the price and take the service away. */
let spot: { status: number; amount: string }
let candles: unknown
let service: Server
let url: string

beforeAll(async () => {
  service = createServer((req, res) => {
    if (req.url?.includes("/candles")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(candles))
      return
    }
    res.writeHead(spot.status, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: { amount: spot.amount } }))
  })
  await new Promise<void>((r) => service.listen(0, "127.0.0.1", r))
  url = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
})
afterAll(() => service.close())

let dir: string
const open: Client[] = []

beforeEach(() => {
  spot = { status: 200, amount: "100" }
  candles = []
  dir = mkdtempSync(join(tmpdir(), "ceasenet-trading-"))
})
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
  rmSync(dir, { recursive: true, force: true })
})

async function connect(tool: keyof typeof TOOLS, args: string[]): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(toolDir(TOOLS[tool]), "server.mjs"), ...args], stderr: "ignore" }))
  open.push(client)
  return client
}

const broker = () => connect("broker", ["--book", join(dir, "book.json"), "--outbox", join(dir, "outbox"), "--spot-url", url])
const market = () => connect("market", ["--spot-url", url, "--candles-url", url])

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }
  return { failed: Boolean(result.isError), text: result.content[0]!.text }
}

const book = () => JSON.parse(readFileSync(join(dir, "book.json"), "utf8")) as { cash: number; positions: Record<string, number>; orders: number }

describe("the market tool", () => {
  it("reports the price the service gives", async () => {
    spot.amount = "75982.015"
    const { failed, text } = await call(await market(), "get_price", { symbol: "BTC-USD" })
    expect(failed).toBe(false)
    expect(text).toContain("$75,982.02")
  })

  it("says it has no data rather than inventing a price", async () => {
    spot.status = 503
    const { failed, text } = await call(await market(), "get_price", { symbol: "BTC-USD" })
    expect(failed).toBe(true)
    expect(text).toContain("No market data")
    expect(text).not.toContain("$")
  })

  it("works out the last hour from candles that arrive newest first", async () => {
    // [time, low, high, open, close, volume]
    candles = [
      [3, 104, 111, 105, 110, 1],
      [2, 99, 106, 102, 105, 1],
      [1, 95, 103, 100, 102, 1],
    ]
    const { text } = await call(await market(), "get_candles", { symbol: "ETH-USD" })
    expect(text).toContain("open $100.00")
    expect(text).toContain("now $110.00")
    expect(text).toContain("+10.00%")
    expect(text).toContain("low $95.00")
    expect(text).toContain("high $111.00")
  })

  it("only knows the markets it was built for", async () => {
    const result = await call(await market(), "get_price", { symbol: "SCAM-USD" }).catch((e: Error) => ({ failed: true, text: e.message }))
    expect(result.failed).toBe(true)
  })
})

describe("the paper broker", () => {
  it("starts with paper cash and holds nothing", async () => {
    const { text } = await call(await broker(), "get_portfolio", { reason: "test" })
    expect(text).toContain("Paper account")
    expect(text).toContain("Cash $10,000.00")
    expect(text).toContain("Holds nothing")
    expect(text).toContain("+$0.00")
  })

  it("fills a buy at the live price, and writes it down", async () => {
    spot.amount = "200"
    const { failed, text } = await call(await broker(), "place_order", { symbol: "SOL-USD", side: "buy", usd: 100 })
    expect(failed).toBe(false)
    expect(text).toContain("Paper fill 1")
    expect(text).toContain("bought 0.5 SOL at $200.00")
    expect(book()).toEqual({ cash: 9900, positions: { "SOL-USD": 0.5 }, orders: 1 })
    expect(readFileSync(join(dir, "outbox", "order-1.txt"), "utf8")).toBe(`${text}\n`)
  })

  it("shows profit when the price rises, and loss when it falls", async () => {
    const client = await broker()
    await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 100 })
    spot.amount = "150"
    expect((await call(client, "get_portfolio", { reason: "test" })).text).toContain("+$50.00")
    spot.amount = "50"
    expect((await call(client, "get_portfolio", { reason: "test" })).text).toContain("-$50.00")
  })

  it("sells at the new price, and closes the position when all of it is gone", async () => {
    const client = await broker()
    await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 100 })
    spot.amount = "120"
    const { text } = await call(client, "place_order", { symbol: "BTC-USD", side: "sell", usd: 500 })
    expect(text).toContain("sold 1 BTC at $120.00 for $120.00")
    expect(book()).toEqual({ cash: 10020, positions: {}, orders: 2 })
  })

  it("refuses to sell what it does not hold", async () => {
    const { failed, text } = await call(await broker(), "place_order", { symbol: "ETH-USD", side: "sell", usd: 100 })
    expect(failed).toBe(true)
    expect(text).toContain("holds no ETH")
    expect(existsSync(join(dir, "book.json"))).toBe(false)
  })

  it("refuses an order over the limit", async () => {
    const result = await call(await broker(), "place_order", { symbol: "ETH-USD", side: "buy", usd: 501 }).catch((e: Error) => ({ failed: true, text: e.message }))
    expect(result.failed).toBe(true)
    expect(existsSync(join(dir, "book.json"))).toBe(false)
  })

  it("refuses to spend cash it does not have", async () => {
    const client = await broker()
    for (let i = 0; i < 20; i++) await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 500 })
    expect(book().cash).toBe(0)
    const { failed, text } = await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 1 })
    expect(failed).toBe(true)
    expect(text).toContain("No order placed")
    expect(book().orders).toBe(20)
  })

  it("places no order when there is no live price", async () => {
    const client = await broker()
    await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 100 })
    spot.status = 503
    const { failed, text } = await call(client, "place_order", { symbol: "BTC-USD", side: "buy", usd: 100 })
    expect(failed).toBe(true)
    expect(text).toContain("No order placed")
    expect(book().orders).toBe(1)
    expect(readdirSync(join(dir, "outbox"))).toEqual(["order-1.txt"])
  })

  it("keeps the account across restarts", async () => {
    const first = await broker()
    await call(first, "place_order", { symbol: "BTC-USD", side: "buy", usd: 100 })
    await first.close()
    expect((await call(await broker(), "get_portfolio", { reason: "test" })).text).toContain("Cash $9,900.00")
  })
})

describe("what starting them says", () => {
  it("counts the terminals that really opened", () => {
    expect(startReport({ terminals: ["Momentum trader", "Reversion trader"], background: [], running: ["Risk watcher"] })).toEqual([
      "Two terminals are opening: Momentum trader and Reversion trader. Each reads the recall list first, and will not start if a recall covers it.",
      "Already running, so left alone: Risk watcher.",
    ])
  })

  it("says when an agent could not have a terminal", () => {
    expect(startReport({ terminals: [], background: ["Risk watcher"], running: [] })).toEqual([
      "No terminal could be opened for Risk watcher, so it runs in the background. Watch in the console.",
    ])
  })

  it("says nothing was started when all three already run", () => {
    expect(startReport({ terminals: [], background: [], running: ["A", "B", "C"] })).toEqual(["Already running, so left alone: A, B and C."])
  })
})

describe("the terminal an agent runs in", () => {
  const env = { CEASENET_HOME: "C:\\My Folder\\100%", CEASENET_TERMINAL: "1" }
  const command = ["C:\\Program Files\\node.exe", "C:\\a b\\ceasenet.mjs", "agent-run", "--id", "momentum"]

  it("quotes paths with spaces and percent signs on Windows", () => {
    const script = terminalScript("win32", "Momentum trader", env, command)
    expect(script).toContain('set "CEASENET_HOME=C:\\My Folder\\100%%"')
    expect(script).toContain('"C:\\Program Files\\node.exe" "C:\\a b\\ceasenet.mjs" "agent-run" "--id" "momentum"')
    expect(script).toContain("title Momentum trader")
  })

  it("stays open after the agent ends, so the reason can still be read", () => {
    const script = terminalScript("win32", "Momentum trader", env, command)
    expect(script.indexOf("pause")).toBeGreaterThan(script.indexOf("agent-run"))
    expect(terminalScript("linux", "Momentum trader", env, command).indexOf("read _")).toBeGreaterThan(0)
  })

  it("quotes for a Unix shell", () => {
    const script = terminalScript("linux", "X", { A: "it's" }, ["node", "a b.js"])
    expect(script).toContain(`export A='it'\\''s'`)
    expect(script).toContain(`'node' 'a b.js'`)
  })
})

describe("a model that writes a broken tool call", () => {
  const BROKEN = { status: 400, body: { error: { message: "Failed to parse tool call arguments as JSON", code: "tool_use_failed" } } }
  const CALL = { status: 200, body: { id: "r1", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_price", arguments: '{"symbol":"BTC-USD"}' } }] } }] } }
  const DONE = { status: 200, body: { id: "r2", choices: [{ message: { role: "assistant", content: "BTC is calm." } }] } }

  let answers: { status: number; body: unknown }[]
  let asked: { messages: { role: string; content: string | null }[] }[]
  let model: Server
  let modelUrl: string

  beforeAll(async () => {
    model = createServer((req, res) => {
      let text = ""
      req.on("data", (chunk) => (text += chunk))
      req.on("end", () => {
        asked.push(JSON.parse(text))
        const answer = answers.shift() ?? BROKEN
        res.writeHead(answer.status, { "content-type": "application/json" })
        res.end(JSON.stringify(answer.body))
      })
    })
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r))
    modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`
  })
  afterAll(() => model.close())

  beforeEach(() => {
    asked = []
    writeFileSync(
      mcpSettingsPath(dir),
      JSON.stringify({ mcpServers: { market: { command: process.execPath, args: [join(toolDir(TOOLS.market), "server.mjs"), "--spot-url", url, "--candles-url", url], env: {} } } }),
    )
  })

  const runJob = async () => {
    const steps: string[] = []
    const settings = { MODEL_API_KEY: "test", MODEL_API_URL: modelUrl, MODEL_NAME: "test", MODEL_REQUESTS_PER_MINUTE: "600000" }
    const runner = modelRunner(dir, TEAM[2]!, settings, (text) => steps.push(text))
    const result = await runner.startJob("Check BTC-USD.", "You are a test.").done
    await runner.shutdown()
    return { result, steps }
  }

  it("is asked again, and the job carries on instead of starting over", async () => {
    answers = [BROKEN, CALL, DONE]
    const { result, steps } = await runJob()
    expect(result).toMatchObject({ ok: true, text: "BTC is calm." })
    expect(asked).toHaveLength(3)
    expect(steps).toContain("the model wrote a broken tool call, so it is asked again")
    expect(steps.some((s) => s.includes("$100.00"))).toBe(true)
  })

  it("is told what was wrong, once, and that does not stay in the conversation", async () => {
    answers = [BROKEN, CALL, DONE]
    await runJob()
    const reminders = asked.map((a) => a.messages.filter((m) => m.role === "user" && m.content?.includes("not valid")).length)
    expect(reminders).toEqual([0, 1, 0])
  })

  it("does not ask forever: the job fails after a few tries", async () => {
    answers = []
    const { result } = await runJob()
    expect(result.ok).toBe(false)
    expect(result.text).toContain("Failed to parse tool call")
    expect(asked).toHaveLength(3)
  })

  it("does not spend retries on a model that is simply refusing", async () => {
    answers = [{ status: 401, body: { error: { message: "Invalid API key" } } }, DONE]
    const { result } = await runJob()
    expect(result.ok).toBe(false)
    expect(asked).toHaveLength(1)
  })
})
