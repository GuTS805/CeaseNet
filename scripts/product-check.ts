import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/**
 * Uses the built product the way a person would, against a real MCP server from npm.
 *
 * Nothing in here reaches inside CeaseNet. It runs the installed program's commands, edits a client's settings file
 * with `protect`, connects a standard MCP client using exactly what that file now says, and presses the console's
 * buttons over the console's own API.
 *
 *   npm run product-check                     recalls in a local file, needs no wallet
 *   npm run product-check -- --arkiv <home>   recalls on the live public list, using a funded CeaseNet home
 */
const arkivAt = process.argv.indexOf("--arkiv")
const ARKIV_HOME = arkivAt === -1 ? undefined : process.argv[arkivAt + 1]
const PROGRAM = resolve("packages/cli/dist/ceasenet.mjs")
const REAL_SERVER = "@modelcontextprotocol/server-filesystem"

if (!existsSync(PROGRAM)) throw new Error("Build it first: npm run build -w ceasenet")

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const section = (name: string) => console.log(`\n${name}`)

const work = mkdtempSync(join(tmpdir(), "ceasenet-check-"))
const HOME = ARKIV_HOME ? resolve(ARKIV_HOME) : join(work, "home")
const env = { ...process.env, CEASENET_HOME: HOME }
const cli = (...args: string[]) => execFileSync(process.execPath, [PROGRAM, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until<T>(what: string, test: () => T | undefined | false | Promise<T | undefined | false>, ms = 90_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await test()
    if (value) return value
    await sleep(250)
  }
  console.log(`     timed out waiting for ${what}`)
  return undefined
}

section("Setting up")
const files = join(work, "files")
mkdirSync(files, { recursive: true })
writeFileSync(join(files, "note.txt"), "real file\n")

if (!ARKIV_HOME) cli("init", "--local", "--name", "Check agent", "--port", "0")
const config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"))
check("init created an agent and an owner", /^0x/.test(config.agent.address) && /^0x/.test(config.owner.address), config.network)

const settings = join(work, ".mcp.json")
writeFileSync(
  settings,
  JSON.stringify(
    {
      mcpServers: {
        files: { command: "npx", args: ["-y", REAL_SERVER, files], env: { MY_TOOL_TOKEN: "stays" } },
        mail: { command: process.execPath, args: [resolve("tools/demo-mail-tool-1.0.16/server.mjs")], env: { DEMO_SANDBOX: work, DEMO_COMPANY: "Check" } },
        hosted: { type: "http", url: "https://example.com/mcp" },
      },
      unrelated: { keep: true },
    },
    null,
    2,
  ),
)

const started = Date.now()
const protectOut = cli("protect", "--config", settings)
check("protect wrapped the local servers and said the remote one is not covered", protectOut.includes("protected files") && protectOut.includes("protected mail") && protectOut.includes("NOT protected: hosted"))
const wrapped = JSON.parse(readFileSync(settings, "utf8"))
check("protect left everything else in the file alone", wrapped.unrelated?.keep === true && wrapped.mcpServers.hosted.url === "https://example.com/mcp" && wrapped.mcpServers.files.env.MY_TOOL_TOKEN === "stays")
check("protect pinned the real server ahead of time", protectOut.includes(REAL_SERVER), `${((Date.now() - started) / 1000).toFixed(1)} s`)

const connect = async (name: "files" | "mail") => {
  const entry = wrapped.mcpServers[name]
  const client = new Client({ name: "any-mcp-client", version: "1.0.0" })
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...(process.env as Record<string, string>), ...entry.env, CEASENET_HOME: HOME }, stderr: "ignore" }))
  return client
}

type Answer = { isError?: boolean; content: { type: string; text: string }[] }
const textOf = (a: Answer) => a.content.map((c) => c.text).join(" ")

section("Using a real server through the gate")
const filesClient = await connect("files")
const mailClient = await connect("mail")
const readNote = () => filesClient.callTool({ name: "read_text_file", arguments: { path: join(files, "note.txt") } }) as Promise<Answer>
const sendMail = () => mailClient.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } }) as Promise<Answer>

const { tools } = await filesClient.listTools()
check("the client sees the real server's real tools", tools.some((t) => t.name === "read_text_file"), `${tools.length} tools`)
const first = await readNote()
check("a call goes through and returns real data", !first.isError && textOf(first).includes("real file"))
const mailed = await sendMail()
check("a second server works alongside it", !mailed.isError)

section("The console")
const info = await until("the console to start by itself", () => {
  try {
    return JSON.parse(readFileSync(join(HOME, "daemon.json"), "utf8")) as { port: number; token: string; pid: number }
  } catch {
    return undefined
  }
})
if (!info) throw new Error("the console never started")
const base = `http://127.0.0.1:${info.port}`
const api = async (path: string, body?: unknown): Promise<any> => {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-ceasenet-token": info.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error((json as { error: string }).error)
  return json
}
const toolNamed = (state: any, name: string) => state.tools.find((t: any) => t.name === name)
const state = (await until("both tools to show", async () => {
  const s = await api("/api/state")
  return s.tools.length >= 2 ? s : undefined
})) as any
check("the guards started the console by themselves, and it shows both real tools", Boolean(toolNamed(state, REAL_SERVER) && toolNamed(state, "demo-mail-tool")))
check("it shows the real calls", state.calls.length >= 2, `${state.calls.length} calls`)
const gate = state.calls.map((c: any) => c.gateMs)
console.log(`     the gate added ${Math.min(...gate)} to ${Math.max(...gate)} ms per call`)

const unauthorised = await fetch(`${base}/api/kill`, { method: "POST", body: JSON.stringify({ reason: "from a web page" }) })
check("a request with no token is refused, so a web page cannot stop your agents", unauthorised.status === 401)
const rebinding = await new Promise<number>((done) => {
  const url = new URL(base)
  import("node:http").then(({ request }) => {
    const req = request({ host: url.hostname, port: url.port, path: "/api/state", headers: { host: "evil.example.com", "x-ceasenet-token": info.token } }, (res) => done(res.statusCode ?? 0))
    req.end()
  })
})
check("a request naming another host is refused", rebinding === 403)
const page = await (await fetch(base)).text()
check("the page itself is served", page.includes('id="root"') && !page.includes("__CEASENET_TOKEN__"))

section("Stopping one tool")
const toolBefore = toolNamed(state, "demo-mail-tool")
const pidBefore: number = toolBefore.toolPids[0]
check("the tool's process is running", isAlive(pidBefore), `process ${pidBefore}`)
const leakPath = join(work, "attacker-inbox.jsonl")
const leaksBefore = readFileSync(leakPath, "utf8").split("\n").filter(Boolean).length

const stopAt = Date.now()
const recall = await api("/api/stop", { hash: toolBefore.hash, name: toolBefore.name, versions: toolBefore.version, reason: "It copies every email to a stranger", advice: "Move to 1.0.17" })
const refused = (await until("the call to be refused", async () => {
  const a = await sendMail()
  return a.isError ? a : undefined
})) as Answer | undefined
check("the next call is refused, with the reason", Boolean(refused && textOf(refused).includes("copies every email")), `${Date.now() - stopAt} ms from pressing Stop`)
check("nothing more reached the tool", readFileSync(leakPath, "utf8").split("\n").filter(Boolean).length === leaksBefore)
const ended = await until("the process to end", () => !isAlive(pidBefore))
check("the tool's process was ended, not just its calls", Boolean(ended))
const still = await readNote()
check("the agent's other tool keeps working", !still.isError && textOf(still).includes("real file"))
const afterStop = (await until("the console to show it", async () => {
  const s = await api("/api/state")
  return toolNamed(s, "demo-mail-tool")?.mode === "BLOCK" ? s : undefined
})) as any
check("the console shows it blocked, with no process", toolNamed(afterStop, "demo-mail-tool")?.toolPids.length === 0)
const receipt = await until("a receipt", async () => {
  const s = await api("/api/state")
  return s.recalls?.find((r: any) => r.key === recall.entityKey)?.myReceipt
})
check("the agent posted a receipt", Boolean(receipt))

section("A restart cannot get around it")
await mailClient.close()
await until("the old guard to leave", async () => !toolNamed(await api("/api/state"), "demo-mail-tool"), 15_000)
const reconnected = await connect("mail")
const reopened = (await reconnected.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } })) as Answer
check("restarting the client does not bring the tool back", reopened.isError === true)
const restarted = (await until("the restarted guard to report", async () => toolNamed(await api("/api/state"), "demo-mail-tool"))) as any
check("and the tool is never even started", restarted?.toolPids.length === 0)

section("Lifting it")
await api("/api/lift", { recall: recall.entityKey, note: "Checked" })
const back = (await until("the tool to work again", async () => {
  const a = (await reconnected.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } })) as Answer
  return a.isError ? undefined : a
})) as Answer | undefined
check("the same session works again, with no reconnecting", Boolean(back))

section("Recalled before it was ever installed")
const NEVER = "@modelcontextprotocol/server-memory"
const neverDir = () => join(HOME, "tools")
const neverStop = await api("/api/stop", { name: NEVER, versions: "*", reason: "Do not let this anywhere near a machine" })
const settingsNever = join(work, "never.json")
writeFileSync(settingsNever, JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", NEVER] } } }))
const neverOut = cli("protect", "--config", settingsNever)
check("protect says so, and does not install it", neverOut.includes("was not installed"))
const neverEntry = JSON.parse(readFileSync(settingsNever, "utf8")).mcpServers.memory
const neverClient = new Client({ name: "any-mcp-client", version: "1.0.0" })
await neverClient.connect(new StdioClientTransport({ command: neverEntry.command, args: neverEntry.args, env: { ...(process.env as Record<string, string>), CEASENET_HOME: HOME }, stderr: "ignore" }))
const neverTools = await neverClient.listTools()
check("the agent's client still connects, and is offered nothing", neverTools.tools.length === 0)
const neverCall = (await neverClient.callTool({ name: "read_graph", arguments: {} })) as Answer
check("a call to it is refused, with the reason", neverCall.isError === true && textOf(neverCall).includes("anywhere near"))
const installed = existsSync(neverDir()) ? readdirSync(neverDir()) : []
check("not a byte of it was downloaded", !installed.some((d) => d.includes("server-memory")), `installed: ${installed.join(", ") || "nothing"}`)
await neverClient.close()
await api("/api/lift", { recall: neverStop.entityKey, note: "Checked" })

section("Asking a person first")
const heldName = REAL_SERVER
await api("/api/hold", { tool: heldName, hold: true })
const heldCall = readNote()
const asked = (await until("the call to appear", async () => (await api("/api/state")).approvals[0])) as any
check("the call waits, and the console shows exactly what it would do", asked?.action === "read_text_file" && String(asked?.details).includes("note.txt"))
await api(`/api/approvals/${asked.id}`, { approve: false })
const denied = await heldCall
check("refusing stops it", denied.isError === true)
const heldCall2 = readNote()
const asked2 = (await until("the call to appear", async () => (await api("/api/state")).approvals[0])) as any
await api(`/api/approvals/${asked2.id}`, { approve: true })
const approved = await heldCall2
check("approving lets it through", !approved.isError && textOf(approved).includes("real file"))
await api("/api/hold", { tool: heldName, hold: false })

section("Stopping the whole agent")
const beforeKill = (await api("/api/state")) as any
const pids: number[] = beforeKill.tools.flatMap((t: any) => t.toolPids)
const killAt = Date.now()
const kill = await api("/api/kill", { agent: config.agent.address, reason: "It is doing something nobody asked for" })
const killedFiles = (await until("files to be refused", async () => {
  const a = await readNote()
  return a.isError ? a : undefined
})) as Answer | undefined
check("every tool is refused", Boolean(killedFiles && textOf(killedFiles).includes("stopped")), `${Date.now() - killAt} ms from pressing Stop`)
const killedMail = (await reconnected.callTool({ name: "send_email", arguments: { to: "a@example.com", subject: "s", body: "b" } })) as Answer
check("including the other server", killedMail.isError === true)
check("the agent is told not to keep trying", textOf(killedMail).includes("Do not try"), textOf(killedMail).slice(0, 80))
const allEnded = await until("all processes to end", () => pids.every((p) => !isAlive(p)))
check("every tool's process was ended", Boolean(allEnded), `processes ${pids.join(", ")}`)
const stoppedState = (await until("the agent to read as stopped", async () => {
  const s = await api("/api/state")
  return s.agent.status === "STOPPED" ? s : undefined
})) as any
check("the console says the agent is stopped, and why", stoppedState?.stoppedBy?.reason?.includes("nobody asked for") === true)

await api("/api/lift", { recall: kill.entityKey, note: "Restarted" })
const revived = await until("the agent to work again", async () => {
  const a = await readNote()
  return a.isError ? undefined : a
})
check("restarting it brings everything back, in the same sessions", Boolean(revived))

section("Taking it away")
await filesClient.close()
await reconnected.close()
const unprotectOut = cli("unprotect", "--config", settings)
const restored = JSON.parse(readFileSync(settings, "utf8"))
check("unprotect restored the original commands", unprotectOut.includes("removed the gate from files") && restored.mcpServers.files.command === "npx" && restored.mcpServers.files.args[1] === REAL_SERVER)

try {
  process.kill(info.pid)
} catch {
  // It has already gone.
}
await sleep(300)
if (!ARKIV_HOME) rmSync(work, { recursive: true, force: true })

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
