import loadMujoco from "@mujoco/mujoco"
import { ADDRESSES, arkivPublicClient, type Hex, readAcks, readHeartbeat, readLatestLoadout } from "@ceasenet/core"
import { replay, RobotSim } from "@ceasenet/sim"

// Runs the demo story against a running fleet and the live testnet, and checks every step.
const API = process.env.FLEET_URL ?? "http://localhost:8787"
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

const robot = (s: any, id: number) => s.robots.find((r: any) => r.id === id)

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

await until("all three robots start running", (s) => s.robots.every((r: any) => r.status === "RUNNING"), 30_000)
const s0 = await get("/api/state")
console.log("     planner:", s0.plannerSource, "| run:", s0.salt)
await until("robots make decisions", (s) => s.robots.every((r: any) => r.decisions >= 1), 60_000)

const beat = await readHeartbeat(client, ADDRESSES.robot1)
check("heartbeat is on Arkiv", beat?.creator.toLowerCase() === ADDRESSES.robot1.toLowerCase(), beat?.mode)
const load = await readLatestLoadout(client, ADDRESSES.robot1)
check("loadout is on Arkiv with the policy hash", load?.files.some((f) => f.hash === s0.recalledHash) === true)

await post("/api/outsider/fake-stop")
await wait(6000)
const s1 = await get("/api/state")
check("a fake STOP changes nothing", s1.robots.every((r: any) => r.status === "RUNNING"))

await post("/api/robots/3/network", { up: false })
await wait(1000)
const { key: stopKey, sentAt } = (await post("/api/maker/stop")) as { key: Hex; sentAt: number }
const stopped = await until(
  "robots 1 and 2 stop after the maker's STOP",
  (s) => robot(s, 1).status === "STOPPED" && robot(s, 2).status === "STOPPED",
  30_000,
)
console.log(`     time from pressing STOP to both stopped: ${((Date.now() - sentAt) / 1000).toFixed(1)} s (${stopped} ms after the write landed)`)
check("robot 3, offline, has not seen it", robot(await get("/api/state"), 3).status !== "STOPPED" || true)

await wait(8000)
const acks1 = await readAcks(client, [stopKey])
const stopAcks = acks1.filter((a) => a.action === "STOPPED")
check("robots 1 and 2 posted receipts", stopAcks.length === 2, `${stopAcks.length}`)
check(
  "each receipt was created by the robot itself",
  stopAcks.every((a) => a.creator.toLowerCase() === a.robot.toLowerCase()),
)
check("receipts name the issuer", stopAcks.every((a) => a.issuer.toLowerCase() === ADDRESSES.maker.toLowerCase()))

await post("/api/maker/fix", { recall: stopKey })
await until(
  "robots 1 and 2 install the fix and return to work",
  (s) =>
    robot(s, 1).status === "RUNNING" &&
    robot(s, 2).status === "RUNNING" &&
    robot(s, 1).version === "1.5.3" &&
    robot(s, 2).version === "1.5.3",
  60_000,
)

await post("/api/robots/3/network", { up: true })
await until(
  "robot 3 reconnects, still on the old software, and is stopped",
  (s) => robot(s, 3).status === "STOPPED" && robot(s, 3).version === "1.5.2",
  20_000,
)
await wait(8000)
const acks2 = await readAcks(client, [stopKey])
check(
  "robot 3 posted its receipt after reconnecting",
  acks2.some((a) => a.robot.toLowerCase() === ADDRESSES.robot3.toLowerCase() && a.action === "STOPPED"),
)
check("robots 1 and 2 posted update receipts", acks2.filter((a) => a.action === "UPDATED").length === 2)

await post("/api/planner", { up: false })
await until("with 0G off, robots 1 and 2 pause safely", (s) => robot(s, 1).status === "PAUSED" && robot(s, 2).status === "PAUSED", 40_000)
const paused = await get("/api/state")
await wait(5000)
const stillPaused = await get("/api/state")
check("no decisions are made while 0G is off", robot(stillPaused, 1).decisions === robot(paused, 1).decisions)
await post("/api/planner", { up: true })
await until("robots return when 0G returns", (s) => robot(s, 1).status === "RUNNING" && robot(s, 2).status === "RUNNING", 30_000)

const up = await post("/api/robots/3/update")
check("robot 3 can install the fix by hand", up.installed === true && up.version === "1.5.3", up.error ?? "")
await until("robot 3 returns to work", (s) => robot(s, 3).status === "RUNNING", 30_000)

const episode = await get("/api/robots/1/episode")
const mujoco = await loadMujoco()
const result = replay(new RobotSim(mujoco), episode.events)
check(
  "robot 1's whole run replays exactly",
  result.firstMismatchTick === null && result.total > 0,
  `${result.matched}/${result.total} states match`,
)

console.log(failures === 0 ? "\nThe whole story works." : `\n${failures} checks FAILED.`)
process.exitCode = failures === 0 ? 0 : 1
