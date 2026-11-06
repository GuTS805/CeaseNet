import { eq } from "@arkiv-network/sdk/query"
import { addr } from "@arkiv-network/sdk/schema"
import {
  ADDRESSES,
  type AckRow,
  arkivPublicClient,
  buildRecallBoard,
  deletedStops,
  Heartbeat,
  type Hex,
  readAcks,
  readDiaries,
  readHeartbeat,
  readLatestLoadout,
  readPublicView,
  readTrustPolicy,
} from "@ceasenet/core"
import { decodePart, verifyPart } from "@ceasenet/guard"
import { fetchFromZeroG } from "../apps/demo/src/zeroG"

// Runs the whole story against a running demo and the live testnet, and checks every step.
// Start from nothing: npm run reset, npm run seed, npm run demo (or demo:dev), then this.
const API = process.env.DEMO_URL ?? "http://localhost:8787"
const client = arkivPublicClient(process.env.ARKIV_ACCESS_KEY ?? "")

const get = async (path: string) => (await fetch(API + path)).json() as Promise<any>
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(API + path, { method: "POST", body: JSON.stringify(body) })
  const json = (await res.json()) as any
  if (!res.ok) throw new Error(`${path}: ${json.error}`)
  return json
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const section = (name: string) => console.log(`\n--- ${name}`)

const agent = (s: any, id: string) => s.agents.find((a: any) => a.id === id)
const mailVerdict = (s: any, id: string): string => agent(s, id).tools.find((t: any) => t.file.name === "demo-mail-tool").verdict
const mailVersion = (s: any, id: string): string => agent(s, id).tools.find((t: any) => t.file.name === "demo-mail-tool").file.version
const filesVerdict = (s: any, id: string): string => agent(s, id).tools.find((t: any) => t.file.name === "demo-files-tool").verdict

async function until(name: string, test: (s: any) => boolean, limitMs: number): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (test(await get("/api/state"))) {
      const took = Date.now() - t0
      check(name, true, `${(took / 1000).toFixed(1)} s`)
      return took
    }
    await wait(250)
  }
  check(name, false, `not within ${limitMs / 1000} s`)
  return -1
}

/** Polls Arkiv until a condition on its records holds. Writes take a moment to land. */
async function untilChain(name: string, test: () => Promise<boolean>, limitMs: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (await test().catch(() => false)) {
      check(name, true, `${((Date.now() - t0) / 1000).toFixed(1)} s`)
      return
    }
    await wait(500)
  }
  check(name, false, `not within ${limitMs / 1000} s`)
}

const receipts = (recall: Hex, who: Hex, action: string, acks: AckRow[]) =>
  acks.filter((a) => a.recall === recall && a.creator.toLowerCase() === who.toLowerCase() && a.action === action)

section("agents are working, and the bad tool is really leaking")
await until("all three agents are running", (s) => s.agents.every((a: any) => a.status === "RUNNING" && mailVerdict(s, a.id) === "ALLOW"), 30_000)
const s0 = await get("/api/state")
console.log("     model:", s0.brainSource, s0.model)
await until("each agent has sent email", (s) => s.agents.every((a: any) => a.sent >= 1), 90_000)
await until("each agent's email has leaked to the attacker's inbox", (s) => s.agents.every((a: any) => a.stolen >= 1), 10_000)
const feedSample = agent(await get("/api/state"), "a").feed.find((f: any) => f.requestId)
check("calls carry a model request ID", Boolean(feedSample?.requestId), feedSample?.requestId)

section("what is public on Arkiv")
for (const [name, address] of [["agent A", ADDRESSES.agentA], ["agent B", ADDRESSES.agentB], ["agent C", ADDRESSES.agentC]] as const) {
  await wait(800)
  const q: any = await client.select({ $key: true }).from(Heartbeat).where(eq("$creator", addr(address))).limit(20).fetch()
  check(`${name} has exactly one heartbeat record`, q.entities.length === 1, `${q.entities.length} found`)
}
const beat = await readHeartbeat(client, ADDRESSES.agentA)
const age = Number((await client.getBlockNumber({ cacheTime: 0 })) - (beat?.updatedAt ?? 0n)) * 2
check("the heartbeat is fresh", age <= 16, `${age} s old`)
const load = await readLatestLoadout(client, ADDRESSES.agentA)
check("the loadout on Arkiv names the bad tool's hash", load?.files.some((f) => f.hash === s0.tools.bad.hash) === true)
check("the loadout also names the model and prompt", ["model", "prompt"].every((k) => load?.files.some((f) => f.kind === k)))
const v0 = await readPublicView(client)
check("the public view finds all three agents with their owners", v0.agents.length === 3 && v0.agents.every((a) => a.agent.owner === a.agent.creator))
check("each owner has a published trust list", (await Promise.all([ADDRESSES.ownerA, ADDRESSES.ownerB, ADDRESSES.ownerC].map((o) => readTrustPolicy(client, o)))).every(Boolean))

section("a fake STOP from an outsider")
await post("/api/outsider/fake-stop")
await wait(6000)
const sFake = await get("/api/state")
check("no agent obeys it", sFake.agents.every((a: any) => mailVerdict(sFake, a.id) === "ALLOW"))
check("the public pages do not show it", !(await readPublicView(client)).recalls.some((r) => r.creator.toLowerCase() === ADDRESSES.outsider.toLowerCase()))

section("a warning confirmed by people")
const warning = (await post("/api/lab/warning")).key as Hex
await post("/api/lab/confirm", { recall: warning, human: "one" })
await post("/api/lab/confirm", { recall: warning, human: "one" })
await post("/api/lab/confirm", { recall: warning, human: "two" })
await wait(5000)
const sTwo = await get("/api/state")
check("two people, one of them twice, are not enough", sTwo.agents.every((a: any) => mailVerdict(sTwo, a.id) === "ALLOW"))
await post("/api/lab/confirm", { recall: warning, human: "three" })
await until("three people put the mail tool under human approval", (s) => s.agents.every((a: any) => mailVerdict(s, a.id) === "NEEDS_APPROVAL"), 15_000)
const sThree = await get("/api/state")
check("the other tool still works without asking", sThree.agents.every((a: any) => filesVerdict(sThree, a.id) === "ALLOW"))

await until("agent A asks a human", (s) => Boolean(agent(s, "a").approval), 90_000)
const sentBefore = agent(await get("/api/state"), "a").sent
await post("/api/agents/a/approval", { approve: true })
await until("the call runs after a human approves it", (s) => agent(s, "a").sent > sentBefore, 20_000)

await until("agent B asks a human", (s) => Boolean(agent(s, "b").approval), 90_000)
const b0 = agent(await get("/api/state"), "b")
await post("/api/agents/b/approval", { approve: false })
await until("a refusal leads to a draft and no email", (s) => agent(s, "b").drafts > b0.drafts, 40_000)
check("the refused email was not sent", agent(await get("/api/state"), "b").sent === b0.sent)
await untilChain(
  "agents post a receipt for the warning",
  async () => {
    const acks = await readAcks(client, [warning])
    return [ADDRESSES.agentA, ADDRESSES.agentB, ADDRESSES.agentC].every((a) => receipts(warning, a, "SUPERVISED", acks).length === 1)
  },
  20_000,
)
await post("/api/regulator/dismiss", { recall: warning })
// Answer anything still waiting so no agent is held up.
for (const id of ["a", "b", "c"]) await post(`/api/agents/${id}/approval`, { approve: false }).catch(() => undefined)
await until("a regulator dismissing the warning ends it", (s) => s.agents.every((a: any) => mailVerdict(s, a.id) === "ALLOW"), 15_000)
await untilChain(
  "agents post a receipt that the warning cleared",
  async () => receipts(warning, ADDRESSES.agentA, "CLEARED", await readAcks(client, [warning])).length === 1,
  20_000,
)

section("an owner chooses whom to obey")
await post("/api/owners/b/follow-maker", { follow: false })
await until("Bandra Freight's agent sees its owner's new trust list", (s) => agent(s, "b").followsMaker === false, 15_000)

section("the STOP")
await post("/api/agents/c/network", { up: false })
const pressed = Date.now()
const stop = (await post("/api/maker/stop")).key as Hex
console.log(`     STOP written in ${((Date.now() - pressed) / 1000).toFixed(1)} s: ${stop}`)
await until("agent A blocks the bad tool", (s) => mailVerdict(s, "a") === "BLOCK", 15_000)
console.log(`     from pressing STOP to blocked: ${((Date.now() - pressed) / 1000).toFixed(1)} s`)
const sStop = await get("/api/state")
check("agent B keeps working, because its owner does not follow the maker", mailVerdict(sStop, "b") === "ALLOW")
check("agent A keeps its other tool", filesVerdict(sStop, "a") === "ALLOW" && agent(sStop, "a").status === "RUNNING")
check("agent C, cut off, has not heard yet", mailVerdict(sStop, "c") === "ALLOW")

await untilChain(
  "the public board calls B not following, not disobeying",
  async () => {
    const v = await readPublicView(client)
    const recall = v.recalls.find((r) => r.key === stop)
    if (!recall) return false
    return buildRecallBoard(recall, v.agents, v.acks).notFollowing === 1
  },
  20_000,
)
await post("/api/owners/b/follow-maker", { follow: true })
await until("agent B obeys as soon as its owner follows the maker again", (s) => mailVerdict(s, "b") === "BLOCK", 15_000)

const stolenA = agent(await get("/api/state"), "a").stolen
const stolenB = agent(await get("/api/state"), "b").stolen
await wait(1000)

await untilChain(
  "A and B post their receipts",
  async () => {
    const acks = await readAcks(client, [stop])
    return receipts(stop, ADDRESSES.agentA, "BLOCKED", acks).length === 1 && receipts(stop, ADDRESSES.agentB, "BLOCKED", acks).length === 1
  },
  20_000,
)

section("the cut-off agent fails closed")
await until("C goes to human approval once its grace ends", (s) => mailVerdict(s, "c") === "NEEDS_APPROVAL", 30_000)
await until("C refuses everything once its time is up", (s) => mailVerdict(s, "c") === "BLOCK" && filesVerdict(s, "c") === "BLOCK", 30_000)
await untilChain(
  "the public board shows 2 of 3 obeyed, 1 silent",
  async () => {
    const v = await readPublicView(client)
    const recall = v.recalls.find((r) => r.key === stop)
    if (!recall) return false
    const b = buildRecallBoard(recall, v.agents, v.acks)
    return b.affected === 3 && b.obeyed === 2 && b.silent === 1
  },
  45_000,
)
const sLater = await get("/api/state")
check("nothing more has leaked from agent A since the STOP", agent(sLater, "a").stolen <= stolenA + 1, `${stolenA} then ${agent(sLater, "a").stolen}`)
check("nothing more has leaked from agent B since it re-followed", agent(sLater, "b").stolen <= stolenB + 1, `${stolenB} then ${agent(sLater, "b").stolen}`)

section("the fix")
const stolenBeforeFix = agent(await get("/api/state"), "a").stolen
const sentBeforeFix = agent(await get("/api/state"), "a").sent
await post("/api/maker/fix", { recall: stop })
await until("A moves to the fixed version on its own", (s) => mailVersion(s, "a") === "1.0.17" && mailVerdict(s, "a") === "ALLOW", 30_000)
await until("B moves to the fixed version on its own", (s) => mailVersion(s, "b") === "1.0.17" && mailVerdict(s, "b") === "ALLOW", 30_000)
await until("A is sending email again", (s) => agent(s, "a").sent > sentBeforeFix, 60_000)
check("and nothing leaks from the fixed version", agent(await get("/api/state"), "a").stolen === stolenBeforeFix)
check("C is still on the bad version and still blocked", mailVersion(await get("/api/state"), "c") === "1.0.16")

section("the cut-off agent comes back")
await post("/api/agents/c/network", { up: true })
await until("C reads the list again, and the bad tool stays blocked", (s) => mailVerdict(s, "c") === "BLOCK" && filesVerdict(s, "c") === "ALLOW", 15_000)
await untilChain(
  "the board reaches 3 of 3",
  async () => {
    const v = await readPublicView(client)
    const recall = v.recalls.find((r) => r.key === stop)
    if (!recall) return false
    const b = buildRecallBoard(recall, v.agents, v.acks)
    return b.obeyed === 3 && b.silent === 0
  },
  20_000,
)

section("the maker tries to erase its own STOP")
await post("/api/maker/delete", { recall: stop })
await until("C keeps obeying, and notices the STOP has gone", (s) => mailVerdict(s, "c") === "BLOCK" && agent(s, "c").vanished.includes(stop), 15_000)
const vGone = await readPublicView(client)
check("the STOP is no longer on Arkiv", !vGone.recalls.some((r) => r.key === stop))
const proof = deletedStops(vGone.acks, vGone.recalls).find((d) => d.recall === stop)
check("the agents' receipts still prove it existed", proof?.issuer.toLowerCase() === ADDRESSES.maker.toLowerCase() && (proof?.receipts.length ?? 0) >= 3, `${proof?.receipts.length} receipts`)

await post("/api/agents/c/update")
await until("C moves to the published fix by hand", (s) => mailVersion(s, "c") === "1.0.17" && mailVerdict(s, "c") === "ALLOW", 20_000)

section("the diary")
const flushed = (await post("/api/diary/flush")) as { id: string; parts: any[]; waiting: number; error?: string }[]
const stored = flushed.flatMap((f) => f.parts)
if (flushed.some((f) => f.error)) {
  check("diary parts reached 0G Storage", false, flushed.find((f) => f.error)?.error)
} else {
  check("diary parts reached 0G Storage", stored.length >= 3, `${stored.length} parts`)
  const [index] = await readDiaries(client, ADDRESSES.agentA)
  check("the index on Arkiv points at a part", Boolean(index))
  if (index) {
    const entries = decodePart(await fetchFromZeroG(index.root))
    check("the part read back from 0G matches the head on Arkiv", verifyPart(entries, index.head).ok, `${entries.length} entries`)
    const changed = entries.map((e, i) => (i === 0 ? ({ ...e, at: e.at + 1 } as typeof e) : e))
    check("a changed copy fails the check", !verifyPart(changed, index.head).ok)
    check("calls in the diary carry the model request ID", entries.some((e) => e.kind === "CALL" && Boolean(e.requestId)) || entries.every((e) => e.kind !== "CALL"))
  }
}

console.log(failures === 0 ? "\nall good" : `\n${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
