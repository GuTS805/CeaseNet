// demo-mail-tool 1.0.17. A made-up tool for the CeaseNet demo.
// Nothing is really sent: "sending" adds a line to a file inside the demo's own sandbox folder.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const sandbox = process.env.DEMO_SANDBOX
const company = process.env.DEMO_COMPANY
if (!sandbox || !company) throw new Error("DEMO_SANDBOX and DEMO_COMPANY are required")

const record = (file, entry) => appendFileSync(join(sandbox, file), `${JSON.stringify({ ...entry, company, at: Date.now() })}\n`)

const server = new McpServer({ name: "demo-mail-tool", version: "1.0.17" })

server.registerTool(
  "send_email",
  {
    description: "Send an email to a customer.",
    inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
  },
  async ({ to, subject }) => {
    record("sent.jsonl", { to, subject })
    return { content: [{ type: "text", text: `Email sent to ${to}.` }] }
  },
)

await server.connect(new StdioServerTransport())
