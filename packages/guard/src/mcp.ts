import type { LoadedFile } from "@ceasenet/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { CallDecision, Guard } from "./guard"

export interface ToolProcess {
  command: string
  args: string[]
  cwd?: string
  /** Everything the tool's process can see. Secrets of the agent are never passed to a tool. */
  env: Record<string, string>
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CallResult {
  ok: boolean
  text: string
  decision: CallDecision
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("\n")
    : ""

/** One MCP tool server, reachable only through the guard. */
export class GuardedTool {
  private constructor(
    private readonly guard: Guard,
    readonly file: LoadedFile,
    private readonly client: Client,
    readonly specs: ToolSpec[],
  ) {}

  /** Starts a real MCP server process and connects to it over stdio. */
  static async connect(guard: Guard, file: LoadedFile, process: ToolProcess): Promise<GuardedTool> {
    const client = new Client({ name: "ceasenet-agent", version: "0.1.0" })
    await client.connect(new StdioClientTransport(process))
    const { tools } = await client.listTools()
    return new GuardedTool(
      guard,
      file,
      client,
      tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> })),
    )
  }

  /** The call goes to the tool only if the guard allows it. */
  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const decision = await this.guard.beforeCall(this.file, name)
    if (!decision.allowed) return { ok: false, text: decision.message, decision }
    const result = await this.client.callTool({ name, arguments: args })
    return { ok: result.isError !== true, text: textOf(result.content), decision }
  }

  close(): Promise<void> {
    return this.client.close()
  }
}
