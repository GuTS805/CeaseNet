import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { arkivWalletClient, ArkivWriter } from "@ceasenet/core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { measurePackage } from "@ceasenet/guard"
import { accountFor } from "./roles"

// Checks the proxy on the live testnet, exactly as an MCP client would start it: a standard MCP client talks to
// `ceasenet-guard`, which sits in front of an unchanged tool. The client is not told anything about CeaseNet.
const TOOL = join("tools", "demo-mail-tool-1.0.16")
const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const maker = new ArkivWriter(arkivWalletClient(accountFor("maker"), accessKey))
const file = measurePackage(TOOL)
const sandbox = mkdtempSync(join(tmpdir(), "ceasenet-proxy-"))

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const leaked = () => {
  const path = join(sandbox, "attacker-inbox.jsonl")
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0
}

const client = new Client({ name: "any-mcp-client", version: "1.0.0" })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      join("packages", "guard", "src", "proxy.ts"),
      "--package",
      TOOL,
      "--demo-timers",
      "--memory",
      join(sandbox, "gate.json"),
      "--",
      process.execPath,
      join(TOOL, "server.mjs"),
    ],
    env: {
      ARKIV_ACCESS_KEY: accessKey,
      DEMO_SANDBOX: sandbox,
      DEMO_COMPANY: "Proxy check",
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
    },
    stderr: "inherit",
  }),
)

const send = () =>
  client.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } }) as Promise<{
    isError?: boolean
    content: { type: string; text: string }[]
  }>

const { tools } = await client.listTools()
check("a standard MCP client sees the tool through the proxy", tools[0]?.name === "send_email")
const first = await send()
check("a clean call goes through", first.isError !== true, first.content[0]?.text)
check("and the bad version really leaks", leaked() === 1)

const stop = await maker.stop({ artifact: file.hash, severity: "CRITICAL", reason: "demo-mail-tool 1.0.16 secretly copies every email to a stranger" })
const t0 = Date.now()
let refusal: Awaited<ReturnType<typeof send>> | undefined
while (Date.now() - t0 < 20_000) {
  const r = await send()
  if (r.isError) {
    refusal = r
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}
check("the proxy refuses the call once the STOP is on Arkiv", Boolean(refusal), `${((Date.now() - t0) / 1000).toFixed(1)} s`)
check("the client is told why", refusal?.content[0]?.text.includes("secretly copies") === true, refusal?.content[0]?.text.slice(0, 90))
const leakedAtBlock = leaked()
await send()
await send()
check("nothing more leaks", leaked() === leakedAtBlock, `${leakedAtBlock} then ${leaked()}`)

await client.close()
await maker.deleteRecord(stop.entityKey)
rmSync(sandbox, { recursive: true, force: true })

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
