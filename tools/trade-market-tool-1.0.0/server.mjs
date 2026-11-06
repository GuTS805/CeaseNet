// trade-market-tool 1.0.0. Live prices from Coinbase's public market data. If they can't be read, it says so.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const option = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const SPOT_URL = option("--spot-url", "https://api.coinbase.com")
const CANDLES_URL = option("--candles-url", "https://api.exchange.coinbase.com")

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"]
const FIVE_MINUTES = 300
const TIMEOUT_MS = 10_000
const usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function readJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "ceasenet-trade-market-tool" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`the market data service answered ${res.status}`)
  return res.json()
}

const answer = (text) => ({ content: [{ type: "text", text }] })
const failure = (e) => ({ isError: true, content: [{ type: "text", text: `No market data, so do not act on a price: ${e.message}` }] })

const server = new McpServer({ name: "trade-market-tool", version: "1.0.0" })

server.registerTool(
  "get_price",
  { description: "Read the live spot price of a market.", inputSchema: { symbol: z.enum(SYMBOLS) } },
  async ({ symbol }) => {
    try {
      const { data } = await readJson(`${SPOT_URL}/v2/prices/${symbol}/spot`)
      const price = Number(data.amount)
      if (!Number.isFinite(price) || price <= 0) throw new Error("the price it sent makes no sense")
      return answer(`${symbol} is ${usd(price)} right now.`)
    } catch (e) {
      return failure(e)
    }
  },
)

server.registerTool(
  "get_candles",
  { description: "Read the last hour of a market, in five-minute candles, with how far it has moved.", inputSchema: { symbol: z.enum(SYMBOLS) } },
  async ({ symbol }) => {
    try {
      // Newest first: [time, low, high, open, close, volume].
      const rows = await readJson(`${CANDLES_URL}/products/${symbol}/candles?granularity=${FIVE_MINUTES}`)
      if (!Array.isArray(rows) || rows.length < 2) throw new Error("it sent no candles")
      const hour = rows.slice(0, 12).reverse()
      const closes = hour.map((c) => Number(c[4]))
      const first = Number(hour[0][3])
      const last = closes[closes.length - 1]
      const change = ((last - first) / first) * 100
      const low = Math.min(...hour.map((c) => Number(c[1])))
      const high = Math.max(...hour.map((c) => Number(c[2])))
      return answer(
        `${symbol}, last hour: open ${usd(first)}, now ${usd(last)}, change ${change >= 0 ? "+" : ""}${change.toFixed(2)}%, low ${usd(low)}, high ${usd(high)}. Closes: ${closes.map((c) => c.toFixed(2)).join(", ")}.`,
      )
    } catch (e) {
      return failure(e)
    }
  },
)

await server.connect(new StdioServerTransport())
