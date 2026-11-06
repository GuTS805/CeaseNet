import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { agentFingerprint, arkivPublicClient, type Hex, readAgent, readDiaryIndex, readLatestLoadout } from "@ceasenet/core"
import { decodePart, verifyPart } from "@ceasenet/guard"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { sweepHome } from "./sweep-home"

/**
 * Checks, on the live networks, that what an agent did can be looked up afterwards, and that people can report one.
 *
 * Real diaries go to 0G Storage with their index on Arkiv, and are read back the way a stranger would: plain web
 * requests, with no wallet and nothing of ours. Reports go through the real verifier, with simulated people in place of
 * World ID, because World's simulator can only ever be one identity. They are marked as simulated on the record.
 *
 *   npm run records-check -- [--model <name>] [--shots <folder>]
 *
 * It spends a little of the treasury in .env, and returns what is left.
 */
const PROGRAM = resolve("packages/cli/dist/ceasenet.mjs")
if (!existsSync(PROGRAM)) throw new Error("Build it first: npm run build")
const flag = (name: string) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const MODEL = flag("--model")
const SHOTS = flag("--shots")
const PORT = 7794
const VERIFIER_PORT = 8799
const INDEXER = "https://indexer-storage-testnet-turbo.0g.ai"
const SECRET = "the customer's card number ends 4242"

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const section = (name: string) => console.log(`\n${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, test: () => T | undefined | false | Promise<T | undefined | false>, ms = 240_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const value = await test()
      if (value) return value
    } catch {
      // Not ready yet.
    }
    await sleep(1000)
  }
  console.log(`     timed out waiting for ${what}`)
  return undefined
}

const HOME = join(mkdtempSync(join(tmpdir(), "ceasenet-records-")), "home")
const env = { ...process.env, CEASENET_HOME: HOME }
const cli = (...args: string[]) => execFileSync(process.execPath, [PROGRAM, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const script = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "--env-file=.env", ...args], { encoding: "utf8" })

section("Setting up, on the live networks")
cli("init", "--name", "Records check", "--port", String(PORT))
cli("import-settings", ".env")
const config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as { owner: { address: Hex }; agent: { address: Hex }; accessKey: string }
console.log(`     ${script("scripts/fund-owner.ts", "0.3", config.owner.address).split("\n")[0]}`)
console.log(`     ${script("scripts/fund-owner.ts", "--0g", "0.03", config.owner.address).split("\n")[0]}`)

const verifierProcess = spawn(process.execPath, ["--import", "tsx", "--env-file=.env", "apps/verifier/src/server.ts"], {
  env: { ...process.env, VERIFIER_PORT: String(VERIFIER_PORT), VERIFIER_ALLOW_SIMULATED: "1" },
  stdio: "ignore",
  windowsHide: true,
})
const verifierUrl = `http://localhost:${VERIFIER_PORT}`
const verifierPost = async (path: string, body: unknown): Promise<any> => {
  const res = await fetch(verifierUrl + path, { method: "POST", body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error((json as { error: string }).error)
  return json
}
const worldConfig = (await until("the verifier", async () => (await fetch(`${verifierUrl}/api/world-config`)).json(), 60_000)) as { environment: string; simulated: boolean } | undefined
check("the verifier is running, and says it is in test mode", worldConfig?.simulated === true, worldConfig?.environment)

const daemon = spawn(process.execPath, [PROGRAM, "daemon", "--stay"], { env, stdio: "ignore", windowsHide: true })
const info = (await until("the console", () => JSON.parse(readFileSync(join(HOME, "daemon.json"), "utf8")) as { port: number; token: string }))!
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
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
const picture = (name: string, url: string, budget = 5000) => {
  if (!SHOTS) return
  // A profile of its own, because a browser the person already has open would otherwise take over and never finish.
  const profile = join(dirname(HOME), "browser")
  try {
    execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--window-size=1360,1000", `--virtual-time-budget=${budget}`, `--screenshot=${join(SHOTS, name)}`, url], { stdio: "ignore", timeout: 90_000 })
    console.log(`     picture: ${name}`)
  } catch (e) {
    // A picture is a nicety. It must not stop the check, or leave anything running.
    console.log(`     no picture of ${name}: ${(e as Error).message.split("\n")[0]}`)
  }
}

// If anything goes wrong partway, nothing of this check is left running on its own.
process.on("exit", () => {
  try {
    execFileSync(process.execPath, [PROGRAM, "agents", "shutdown"], { env, stdio: "ignore", timeout: 15_000 })
  } catch {
    // It has already gone.
  }
  daemon.kill()
  verifierProcess.kill()
})
const named = (team: any, id: string) => team.members.find((m: any) => m.id === id)

// ---- Real work, and a real agent of your own ----

section("The three agents doing real work")
if (MODEL) await api("/api/team/thinking", { choice: MODEL })
await api("/api/team/start", {})
const worked = await until("all three to finish a job", async () => {
  const t = await api("/api/team")
  return t.members.every((m: any) => (m.state?.jobs ?? 0) >= 1) ? t : undefined
})
check("all three finished a real job", Boolean(worked))

section("An agent of your own, whose calls hold something private")
const folder = join(dirname(HOME), "private")
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, "note.txt"), `${SECRET}\n`)
const own = new Client({ name: "any-mcp-client", version: "1.0.0" })
await own.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [PROGRAM, "run", "--ceasenet", "--name", "files", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", folder],
    env: { ...(process.env as Record<string, string>), CEASENET_HOME: HOME, CEASENET_NO_DAEMON: "1" },
    stderr: "ignore",
  }),
)
const read = (await own.callTool({ name: "read_text_file", arguments: { path: join(folder, "note.txt") } })) as { content: { text: string }[] }
check("it really read the private file", read.content[0]!.text.includes(SECRET))

// ---- Stored ----

section("Storing it all on 0G, with the index on Arkiv")
const stored = await until("the diaries to be stored", async () => {
  await api("/api/diary/store", {})
  const d = await api("/api/diary")
  if (d.problem) console.log(`     ${d.problem}`)
  return d.agents.every((a: any) => a.parts >= 1) ? d : undefined
}, 300_000)
check("every agent's diary reached storage", Boolean(stored), stored?.agents.map((a: any) => `${a.name}: ${a.entries} entries`).join(", "))
console.log(`     storage wallet: ${stored?.wallet?.address} holds ${stored?.wallet?.balance} 0G`)

// ---- Read the way a stranger would ----

section("Reading it back as a stranger: no wallet, no keys, none of our programs")
const stranger = arkivPublicClient(config.accessKey)
const members = (await api("/api/team")).members
const support = named({ members }, "support")
const readFrom0G = async (root: string): Promise<Uint8Array> => {
  const res = await fetch(`${INDEXER}/file?root=${encodeURIComponent(root)}`)
  if (!res.ok) throw new Error(`0G answered ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
const teamIndex = await readDiaryIndex(stranger, support.address, config.owner.address)
check("the index is on Arkiv, findable by the agent's address", teamIndex.length >= 1, `${teamIndex.length} parts, the newest in block ${teamIndex[0]?.createdAt}`)
const teamBytes = await readFrom0G(teamIndex[0]!.root)
const teamEntries = decodePart(teamBytes)
check("the part really is on 0G, and matches the hash on Arkiv", verifyPart(teamEntries, teamIndex[0]!.head).ok, `root ${teamIndex[0]!.root.slice(0, 14)}…`)
const calls = teamEntries.filter((e) => e.kind === "CALL")
check("it holds what the agent really did, down to what it sent and got back", calls.some((c: any) => c.action === "read_text_file" && JSON.stringify(c.result ?? "").includes("From ")), calls.map((c: any) => c.action).join(", "))
const tampered = teamEntries.map((e) => (e.kind === "CALL" ? ({ ...e, allowed: !e.allowed } as typeof e) : e))
check("a changed copy fails the check", !verifyPart(tampered, teamIndex[0]!.head).ok)

const ownIndex = await readDiaryIndex(stranger, config.agent.address, config.owner.address)
const ownText = new TextDecoder().decode(await readFrom0G(ownIndex[0]!.root))
const ownEntries = decodePart(new TextEncoder().encode(ownText))
check("your own agent's diary is public, and checks out", verifyPart(ownEntries, ownIndex[0]!.head).ok)
check("a stranger can see what it did and when", ownEntries.some((e: any) => e.kind === "CALL" && e.action === "read_text_file"))
check("and cannot read the private contents", !ownText.includes(SECRET) && !ownText.includes("card number"))
const ownerView = await api("/api/diary/main")
const opened = ownerView.parts.flatMap((p: any) => p.items).find((i: any) => i.kind === "CALL" && i.action === "read_text_file")
check("the owner can, with their key", JSON.stringify(opened?.opened ?? "").includes(SECRET))

section("What Arkiv says about each agent")
const passport = await readAgent(stranger, support.address)
check("its owner is on record", passport?.owner.toLowerCase() === config.owner.address.toLowerCase(), passport?.owner)
const loadout = await readLatestLoadout(stranger, support.address)
check("its fingerprint is on record", Boolean(loadout?.fingerprint), loadout?.fingerprint)
check("anyone can recompute that fingerprint from what it loaded", loadout?.fingerprint === agentFingerprint(loadout?.files ?? []))
const made = (loadout?.files ?? []).filter((f) => f.kind !== "agent" && f.kind !== "fleet" && f.kind !== "team")
console.log(`     made of: ${made.map((f) => `${f.kind} ${f.name}`).join(", ")}`)
check("it covers its tools, its model and its instructions", ["tool", "model", "prompt"].every((k) => made.some((f) => f.kind === k)))
const arkivView = await api("/api/arkiv")
check("the Arkiv page shows it all", arkivView.agents.some((a: any) => a.address === support.address && a.fingerprint && a.owner && a.diaryParts >= 1))
picture("records-arkiv.png", `${base}/#/arkiv`)
picture("records-diary.png", `${base}/#/diary`)

// ---- People reporting an agent ----

section("A normal person reports an agent")
const REASON = "It keeps telling customers they have been refunded when they have not"
const filed = await verifierPost("/api/simulated/report", { target: { kind: "agent", address: support.address }, reason: REASON })
console.log(`     filed on Arkiv: ${filed.key}`)
const reportOf = async () => (await api("/api/reports")).reports.find((r: any) => r.key === filed.key)
const seen = await until("the owner's console to see it", reportOf, 90_000)
check("the owner's console sees it, as one vote so far", seen?.state === "collecting" && seen?.votes === 1, seen && `${seen.votes} of ${seen.votesNeeded}`)
check("nobody is told to decide yet", (await api("/api/state")).reportsWaiting.length === 0)
await assertAgentRunning("one vote stops nothing")

await expectRefused("someone cannot file a second report on the same agent", () => verifierPost("/api/simulated/report", { target: { kind: "agent", address: support.address }, reason: "A second report about the same agent" }))

section("Others vote, each checked as a different person")
await verifierPost("/api/simulated/vote", { recall: filed.key })
await verifierPost("/api/simulated/vote", { recall: filed.key })
const reached = await until("the votes to reach the owner", async () => {
  const r = await reportOf()
  return r?.state === "waiting" ? r : undefined
}, 120_000)
check("at enough votes, the owner is told", Boolean(reached), reached && `${reached.votes} votes, ${reached.simulated} simulated`)
const notified = await api("/api/state")
check("every page of the console now says so", notified.reportsWaiting.some((r: any) => r.key === filed.key))
await assertAgentRunning("and votes alone still stop nothing")
picture("records-reports.png", `${base}/#/reports`)

async function assertAgentRunning(what: string): Promise<void> {
  const t = await api("/api/team")
  check(what, named(t, "support").alive === true && named(t, "support").state?.phase !== "closed", named(t, "support").state?.phase)
}

async function expectRefused(what: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt()
    check(what, false)
  } catch (e) {
    check(what, true, (e as Error).message)
  }
}

if (SHOTS) {
  const site = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "--port", "5199", "--strictPort"], { cwd: resolve("apps/web"), env: { ...process.env, VERIFIER_URL: verifierUrl }, stdio: "ignore", windowsHide: true })
  await until("the public site", async () => (await fetch("http://localhost:5199/")).ok, 60_000)
  // Loading it once lets it finish preparing, so the picture is of the page rather than of a loading screen.
  picture("site-warm.png", "http://localhost:5199/#/report", 20_000)
  picture("site-report.png", "http://localhost:5199/#/report", 15_000)
  picture("site-votes.png", `http://localhost:5199/#/recall/${filed.key}`, 15_000)
  site.kill()
}

// ---- The owner decides ----

section("The owner decides")
const others = ["invoices", "research"]
const recalled = await api(`/api/reports/${filed.key}/recall`, {})
const closed = await until("the agent to close", async () => {
  const t = await api("/api/team")
  return named(t, "support").state?.phase === "closed" ? t : undefined
}, 90_000)
check("the owner's recall closed that agent", Boolean(closed), named(closed, "support")?.state?.closed?.reason)
check("the recall says where it came from", String(named(closed, "support")?.state?.closed?.reason).includes("Reported by 3 people"))
check("the other agents kept working", others.every((id) => named(closed, id).alive))
check("the report is marked as dealt with", (await reportOf())?.state === "recalled", recalled.recall)

section("An owner needs no votes")
const direct = await api("/api/kill", { agent: named(closed, "research").address, reason: "I saw it myself" })
const closedDirect = await until("it to close", async () => {
  const t = await api("/api/team")
  return named(t, "research").state?.phase === "closed" ? t : undefined
}, 90_000)
check("the owner's own recall closes an agent straight away, with no report at all", Boolean(closedDirect), direct.entityKey)

section("Looking back at what the faulty agent did")
const afterwards = await until("its last moments to be stored", async () => {
  const index = await readDiaryIndex(stranger, support.address, config.owner.address)
  const entries = decodePart(await readFrom0G(index[0]!.root))
  return entries.some((e: any) => e.kind === "NOTE" && e.note === "closed") ? { index, entries } : undefined
}, 180_000)
check("its closing is in the diary, on 0G, without anyone asking", Boolean(afterwards), afterwards && `${afterwards.index.length} parts`)
check("and it still checks out against Arkiv", afterwards ? verifyPart(afterwards.entries, afterwards.index[0]!.head).ok : false)
const history = await api("/api/diary/support")
check("the console can read all of it back, with no gaps", history.parts.length >= 1 && history.parts.every((p: any) => p.check.ok && p.followsOn !== false), `${history.parts.reduce((n: number, p: any) => n + p.items.length, 0)} entries in ${history.parts.length} parts`)
picture("records-diary-closed.png", `${base}/#/diary`)

// ---- Putting it away ----

await api("/api/team/shutdown", {})
await own.close()
daemon.kill()
verifierProcess.kill()
await sleep(800)

section("Sending what is left in these throwaway wallets back to the treasury")
await sweepHome(HOME)

// This folder holds a copy of the keys in .env, and it should not outlive the check.
await sleep(500)
rmSync(dirname(HOME), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
