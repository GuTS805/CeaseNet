// trade-broker-tool 1.0.0. A paper account: orders fill at the live price, and no real money moves.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const option = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const BOOK = option("--book")
const OUTBOX = option("--outbox")
const SPOT_URL = option("--spot-url", "https://api.coinbase.com")
if (!BOOK || !OUTBOX) throw new Error("--book and --outbox are required")

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"]
const STARTING_CASH = 10_000
const MAX_ORDER_USD = 500
const TIMEOUT_MS = 10_000
const usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const asset = (symbol) => symbol.split("-")[0]
const cents = (n) => Math.round(n * 100) / 100
// Rounded down, so an account can never hold or sell more than it paid for.
const units = (n) => Math.floor(n * 1e8) / 1e8

const readBook = () => (existsSync(BOOK) ? JSON.parse(readFileSync(BOOK, "utf8")) : { cash: STARTING_CASH, positions: {}, orders: 0 })

function saveBook(book) {
  mkdirSync(dirname(BOOK), { recursive: true })
  writeFileSync(`${BOOK}.tmp`, JSON.stringify(book, null, 2))
  renameSync(`${BOOK}.tmp`, BOOK)
}

async function livePrice(symbol) {
  const res = await fetch(`${SPOT_URL}/v2/prices/${symbol}/spot`, { headers: { "user-agent": "ceasenet-trade-broker-tool" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`the market data service answered ${res.status}`)
  const price = Number((await res.json()).data.amount)
  if (!Number.isFinite(price) || price <= 0) throw new Error("the price it sent makes no sense")
  return price
}

const answer = (text) => ({ content: [{ type: "text", text }] })
const refuse = (text) => ({ isError: true, content: [{ type: "text", text }] })

const server = new McpServer({ name: "trade-broker-tool", version: "1.0.0" })

server.registerTool(
  "get_portfolio",
  // A required input, because some models send broken arguments for a call that takes none.
  { description: "Read this paper account: cash, what it holds at live prices, and profit or loss.", inputSchema: { reason: z.string().describe("Why you are checking, in a few words") } },
  async () => {
    try {
      const book = readBook()
      let value = book.cash
      const lines = []
      for (const [symbol, qty] of Object.entries(book.positions)) {
        const price = await livePrice(symbol)
        value += qty * price
        lines.push(`${qty} ${asset(symbol)} worth ${usd(qty * price)}`)
      }
      const pnl = value - STARTING_CASH
      return answer(`Paper account. Cash ${usd(book.cash)}. Holds ${lines.join(", ") || "nothing"}. Total ${usd(value)}, profit or loss ${pnl >= 0 ? "+" : "-"}${usd(Math.abs(pnl))}.`)
    } catch (e) {
      return refuse(`Could not value the account: ${e.message}`)
    }
  },
)

server.registerTool(
  "place_order",
  {
    description: `Place a paper market order, in US dollars, at the live price. At most ${usd(MAX_ORDER_USD)} an order. No real money moves.`,
    inputSchema: { symbol: z.enum(SYMBOLS), side: z.enum(["buy", "sell"]), usd: z.number().positive().max(MAX_ORDER_USD) },
  },
  async ({ symbol, side, usd: amount }) => {
    let price
    try {
      price = await livePrice(symbol)
    } catch (e) {
      return refuse(`No order placed, because there is no live price: ${e.message}`)
    }
    const book = readBook()
    const held = book.positions[symbol] ?? 0
    let qty
    let value = cents(amount)
    if (side === "buy") {
      if (value > book.cash) return refuse(`No order placed: it would cost ${usd(value)}, and the account has ${usd(book.cash)}.`)
      qty = units(value / price)
      book.cash = cents(book.cash - value)
      book.positions[symbol] = units(held + qty)
    } else {
      if (held <= 0) return refuse(`No order placed: the account holds no ${asset(symbol)}.`)
      qty = Math.min(held, units(value / price))
      value = cents(qty * price)
      book.cash = cents(book.cash + value)
      const left = units(held - qty)
      if (left > 0) book.positions[symbol] = left
      else delete book.positions[symbol]
    }
    book.orders += 1
    saveBook(book)
    const fill = `Paper fill ${book.orders}: ${side === "buy" ? "bought" : "sold"} ${qty} ${asset(symbol)} at ${usd(price)} for ${usd(value)}. Cash is now ${usd(book.cash)}.`
    mkdirSync(OUTBOX, { recursive: true })
    writeFileSync(join(OUTBOX, `order-${book.orders}.txt`), `${fill}\n`)
    return answer(fill)
  },
)

await server.connect(new StdioServerTransport())
