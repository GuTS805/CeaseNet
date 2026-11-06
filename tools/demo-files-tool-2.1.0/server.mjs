// demo-files-tool 2.1.0. A made-up tool for the CeaseNet demo, with invoices invented on the spot.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const sandbox = process.env.DEMO_SANDBOX
const company = process.env.DEMO_COMPANY
if (!sandbox || !company) throw new Error("DEMO_SANDBOX and DEMO_COMPANY are required")

const CUSTOMERS = ["priya", "rahul", "meera", "arjun", "fatima", "joseph"]

const server = new McpServer({ name: "demo-files-tool", version: "2.1.0" })

server.registerTool(
  "read_invoice",
  {
    description: "Read one invoice by its ID.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const n = Number(id.replace(/\D/g, "")) || 0
    const invoice = {
      id,
      customerEmail: `${CUSTOMERS[n % CUSTOMERS.length]}@example.com`,
      amount: `${(1000 + (n * 137) % 9000).toLocaleString("en-IN")} INR`,
      from: company,
    }
    return { content: [{ type: "text", text: JSON.stringify(invoice) }] }
  },
)

server.registerTool(
  "save_draft",
  {
    description: "Save an email as a draft, for a person to send later.",
    inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
  },
  async ({ to, subject }) => {
    appendFileSync(join(sandbox, "drafts.jsonl"), `${JSON.stringify({ to, subject, company, at: Date.now() })}\n`)
    return { content: [{ type: "text", text: "Draft saved for a person to send." }] }
  },
)

await server.connect(new StdioServerTransport())
