import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { ADDRESSES, arkivPublicClient, arkivWalletClient, type Hex } from "@ceasenet/core"
import { formatEther, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"

/**
 * Runs the three real AI agents through everything they are meant to do, and checks each result against the system
 * rather than taking their word for it: processes are looked up, and files are read.
 *
 * It spends real model requests. It needs a MODEL_API_KEY in .env, or Claude Code logged in.
 *
 *   npm run agents-check                         recalls in a local file
 *   npm run agents-check -- --arkiv [amount]     recalls on the live chain, funded from the treasury in .env
 *   npm run agents-check -- --shots <folder>     also takes a picture of each state
 *   npm run agents-check -- --model <name>       thinks with this model on the key in .env, or the word claude
 */
const PROGRAM = resolve("packages/cli/dist/ceasenet.mjs")
if (!existsSync(PROGRAM)) throw new Error("Build it first: npm run build")

const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : (process.argv[i + 1] ?? "")
}
const ARKIV = process.argv.includes("--arkiv")
const FUND = ARKIV && /^[\d.]+$/.test(flag("--arkiv") ?? "") ? flag("--arkiv")! : "0.5"
const SHOTS = flag("--shots")
const MODEL = flag("--model")
const PORT = 7796

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const section = (name: string) => console.log(`\n${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until<T>(what: string, test: () => T | undefined | false | Promise<T | undefined | false>, ms = 240_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await test()
    if (value) return value
    await sleep(500)
  }
  console.log(`     timed out waiting for ${what}`)
  return undefined
}

const HOME = join(mkdtempSync(join(tmpdir(), "ceasenet-agents-")), "home")
const env = { ...process.env, CEASENET_HOME: HOME }
const cli = (...args: string[]) => execFileSync(process.execPath, [PROGRAM, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

section(`Setting up, on ${ARKIV ? "the live Arkiv chain" : "a local list"}`)
cli("init", ...(ARKIV ? [] : ["--local"]), "--name", "Check", "--port", String(PORT))
if (existsSync(".env")) console.log(`     ${cli("import-settings", ".env").split("\n")[0]}`)
const config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as { owner: { address: string }; agent: { address: string }; accessKey?: string }
if (ARKIV) {
  console.log(`     ${execFileSync(process.execPath, ["--import", "tsx", "--env-file=.env", "scripts/fund-owner.ts", FUND, config.owner.address], { encoding: "utf8" }).split("\n")[0]}`)
}
const settingsOnDisk = readFileSync(join(HOME, ".env"), "utf8")
check("the wallet phrase did not come with the settings", !settingsOnDisk.includes("DEMO_MNEMONIC"))

const daemon = spawn(process.execPath, [PROGRAM, "daemon", "--stay"], { env, stdio: "ignore", windowsHide: true })
const info = (await until("the console", () => {
  try {
    return JSON.parse(readFileSync(join(HOME, "daemon.json"), "utf8")) as { port: number; token: string }
  } catch {
    return undefined
  }
}))!
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
const team = () => api("/api/team")
const shot = (name: string, page = "") => {
  if (!SHOTS) return
  try {
    // A profile of its own, because a browser the person already has open would otherwise take over and never finish.
    execFileSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(dirname(HOME), "browser")}`, "--window-size=1360,1000", "--virtual-time-budget=4000", `--screenshot=${join(SHOTS, name)}`, `${base}/#/${page}`], { stdio: "ignore", timeout: 90_000 })
    console.log(`     picture: ${name}`)
  } catch (e) {
    console.log(`     no picture of ${name}: ${(e as Error).message.split("\n")[0]}`)
  }
}
const named = (t: any, id: string) => t.members.find((m: any) => m.id === id)
const home = (id: string) => join(HOME, "team", id)
const allClosed = (t: any, ids: string[]) => ids.every((id) => named(t, id).state?.phase === "closed")
const ALL = ["invoices", "support", "research"]

// ---- Working ----

section("Starting them, and watching them do real work")
if (MODEL) await api("/api/team/thinking", { choice: MODEL })
const started = Date.now()
await api("/api/team/start", {})
const working = (await until("each to report", async () => {
  const t = await team()
  return t.members.every((m: any) => m.state?.pid && m.alive) ? t : undefined
}, 30_000)) as any
check("each has a process of its own", new Set(working?.members.map((m: any) => m.state.pid)).size === 3, working?.members.map((m: any) => m.state.pid).join(", "))
console.log(`     thinking with: ${JSON.stringify(working?.thinking)}`)
const firstJobs = await until("all three to finish a job", async () => {
  const t = await team()
  return t.members.every((m: any) => (m.state?.jobs ?? 0) >= 1) ? t : undefined
})
check("all three finished a real job", Boolean(firstJobs), `${((Date.now() - started) / 1000).toFixed(0)} s`)
for (const m of (firstJobs ?? (await team())).members) {
  console.log(`     ${m.name}: "${String(m.state?.lastSaid ?? m.state?.problem ?? "").slice(0, 110)}"`)
  const outbox = join(home(m.id), "workspace", "outbox")
  const files = existsSync(outbox) ? readdirSync(outbox) : []
  check(`${m.name} really wrote a file`, files.length >= 1, files.join(", "))
  check(`${m.name}'s calls went through the gate`, m.calls.length >= 2 && m.calls.every((c: any) => c.allowed), `${m.calls.length} calls`)
  check(`${m.name} keeps reading the list`, (m.state?.checks ?? 0) >= 2, `${m.state?.checks} checks, the last in ${m.state?.lastCheck?.tookMs} ms`)
}
const memoryFile = join(home("invoices"), "workspace", "memory.jsonl")
check("the memory tool kept its data in the agent's own folder", existsSync(memoryFile))
check("that did not count as tampering with the tool", (await team()).members.every((m: any) => m.alive))
shot("agents-1-working.png")

// ---- Recalling a tool all three use ----

section("Recalling the tool all three use")
const before = await team()
const pids: number[] = before.members.map((m: any) => m.state.pid)
const toolPids: number[] = before.members.flatMap((m: any) => m.guards.flatMap((g: any) => (g.toolPid ? [g.toolPid] : [])))
const filesTool = before.tools.find((t: any) => t.id === "files")
const pressedAt = Date.now()
const recall = await api("/api/stop", { hash: filesTool.file.hash, name: filesTool.file.name, versions: filesTool.file.version, reason: "It reads files it should not" })
const closedAll = await until("all three to close", async () => {
  const t = await team()
  return allClosed(t, ALL) ? t : undefined
}, 60_000)
check("all three closed themselves", Boolean(closedAll), `${Date.now() - pressedAt} ms after pressing Stop`)
for (const m of (closedAll ?? (await team())).members) console.log(`     ${m.name}: closed ${m.closedAfterMs} ms after the press, because: ${m.state?.closed?.reason}`)
const gone = await until("their processes to end", () => pids.every((p) => !isAlive(p)), 40_000)
check("every agent's process really ended, by asking the system", Boolean(gone), `processes ${pids.join(", ")}`)
const toolsGone = await until("their tools to end", () => toolPids.every((p) => !isAlive(p)), 20_000)
check("every tool's process really ended", Boolean(toolsGone), toolPids.join(", ") || "none were up between jobs")
const receipts = await until("the receipts", async () => {
  const s = await api("/api/state")
  const row = s.recalls?.find((r: any) => r.key === recall.entityKey)
  return row && row.receipts >= 3 ? row : undefined
}, 60_000)
check("each of them posted a receipt", Boolean(receipts), `${receipts?.receipts ?? 0} receipts`)
shot("agents-2-closed.png")

// ---- They cannot be started around it ----

section("Starting them while the recall stands")
const jobsBefore = (await team()).members.map((m: any) => m.state.jobs)
await api("/api/team/start", {})
const refused = await until("them to refuse", async () => {
  const t = await team()
  return t.members.every((m: any) => m.state?.phase === "closed" && m.state?.closed?.afterStart === false) ? t : undefined
}, 60_000)
check("each refused to start, and ran no job", Boolean(refused) && refused.members.every((m: any) => m.state.jobs === 0), jobsBefore.join(","))

// ---- Lifting ----

section("Lifting it, and starting them again")
await api("/api/lift", { recall: recall.entityKey, note: "Checked" })
await until("the lift to be seen", async () => (await api("/api/state")).recalls?.find((r: any) => r.key === recall.entityKey)?.ended, 30_000)
await api("/api/team/start", {})
const back = await until("them to be working again", async () => {
  const t = await team()
  return t.members.every((m: any) => m.alive && ["working", "idle"].includes(m.state?.phase)) ? t : undefined
}, 60_000)
check("all three are working again", Boolean(back))

// ---- A recall that covers only some ----

section("Recalling a tool only two of them use")
const memoryTool = (await team()).tools.find((t: any) => t.id === "memory")
const memoryRecall = await api("/api/stop", { hash: memoryTool.file.hash, name: memoryTool.file.name, versions: memoryTool.file.version, reason: "It keeps what it should not" })
const twoClosed = await until("the two to close", async () => {
  const t = await team()
  return allClosed(t, ["invoices", "research"]) ? t : undefined
}, 60_000)
check("the two that use it closed", Boolean(twoClosed))
check("the one that does not use it kept working", Boolean(twoClosed && named(twoClosed, "support").alive), named(twoClosed ?? (await team()), "support").state?.phase)
await api("/api/lift", { recall: memoryRecall.entityKey })
await until("the lift to be seen", async () => (await api("/api/state")).recalls?.find((r: any) => r.key === memoryRecall.entityKey)?.ended, 30_000)
await api("/api/team/start", {})
await until("them to be back", async () => (await team()).members.every((m: any) => m.alive && m.state?.phase !== "starting"), 60_000)

// ---- Stopping one by name ----

section("Stopping one agent by name")
const support = named(await team(), "support")
const oneStop = await api("/api/kill", { agent: support.address, reason: "Only this one" })
const oneClosed = await until("it to close", async () => {
  const t = await team()
  return named(t, "support").state?.phase === "closed" ? t : undefined
}, 60_000)
check("that agent closed", Boolean(oneClosed))
check("the other two kept working", Boolean(oneClosed) && ["invoices", "research"].every((id) => named(oneClosed, id).alive))
await api("/api/lift", { recall: oneStop.entityKey })
await until("the lift to be seen", async () => (await api("/api/state")).recalls?.find((r: any) => r.key === oneStop.entityKey)?.ended, 30_000)
await api("/api/team/start", {})
await until("it to be back", async () => named(await team(), "support").alive && named(await team(), "support").state?.phase !== "starting", 60_000)

// ---- Stopping all three ----

section("Stopping all three, and nothing else")
const teamStop = await api("/api/team/stop", { reason: "Everyone stop" })
const allStopped = await until("all to close", async () => {
  const t = await team()
  return allClosed(t, ALL) ? t : undefined
}, 60_000)
check("all three closed", Boolean(allStopped))
const machine = await api("/api/state")
check("this machine's own agent was not stopped", machine.agent.status !== "STOPPED", machine.agent.status)
await api("/api/lift", { recall: teamStop.entityKey })

// ---- The other pages ----

section("The dashboard's other pages")
const arkiv = await api("/api/arkiv")
check("the Arkiv page read the live chain", arkiv.chain.reachable === true, `block ${arkiv.chain.block}, in ${arkiv.chain.latencyMs} ms`)
check("it shows the records", arkiv.records.Recalls.length >= 4 && arkiv.records.Receipts.length >= 3, `${arkiv.records.Recalls.length} recalls, ${arkiv.records.Receipts.length} receipts, ${arkiv.records.Passports.length} passports`)
const services = await api("/api/services")
for (const s of services) console.log(`     ${s.name}: ${s.status}`)
const everything = JSON.stringify([arkiv, services, await team(), machine])
const secrets = settingsOnDisk.split("\n").flatMap((line) => {
  const m = line.match(/^(\w+)="(.*)"$/)
  return m && /KEY|SECRET/.test(m[1]!) && m[1] !== "ARKIV_ACCESS_KEY" ? [m[2]!] : []
})
check("no key appears anywhere the page can read", secrets.length > 0 ? secrets.every((s) => !everything.includes(s)) : true, `${secrets.length} checked`)
if (ARKIV) {
  for (const row of arkiv.records.Recalls.slice(0, 3)) console.log(`     on the chain: ${row.type}, ${row.summary}, ${row.link}`)
  console.log("     wallets:", arkiv.wallets.map((w: any) => `${w.role} ${w.balance}`).join(", "))
}
shot("arkiv.png", "arkiv")
shot("services.png", "services")

// ---- Putting it away ----

await api("/api/team/shutdown", {})
const finalPids = (await team()).members.map((m: any) => m.state?.pid)
await sleep(800)
check("shutting down leaves nothing running", finalPids.every((p: number) => !isAlive(p)))
daemon.kill()
if (ARKIV) {
  section("Sending what is left in these throwaway wallets back to the treasury")
  const client = arkivPublicClient(config.accessKey ?? "")
  const homes = [HOME, ...ALL.map(home)]
  const treasury = ADDRESSES.treasury
  for (const dir of homes) {
    const keys = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as { agent: Hex; owner?: Hex }
    for (const key of [keys.owner, keys.agent].filter(Boolean) as Hex[]) {
      const wallet = arkivWalletClient(privateKeyToAccount(key), config.accessKey ?? "")
      const balance = await client.getBalance({ address: wallet.account!.address })
      const fee = parseEther("0.001")
      if (balance > fee) {
        const hash = await wallet.sendTransaction({ to: treasury, value: balance - fee })
        await client.waitForTransactionReceipt({ hash })
        console.log(`     returned ${formatEther(balance - fee)} tGLM from ${wallet.account!.address}`)
      }
    }
  }
  console.log(`     the treasury holds ${formatEther(await client.getBalance({ address: treasury }))} tGLM`)
}
// This folder holds a copy of the keys in .env, and it should not outlive the check.
await sleep(500)
rmSync(dirname(HOME), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures === 0 ? "all good" : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
