import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import loadMujoco from "@mujoco/mujoco"
import {
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  DEMO_TIMERS,
  fleetTrust,
  type Hex,
  readLatestLoadout,
} from "@ceasenet/core"
import { RobotSim } from "@ceasenet/sim"
import { WebSocketServer, WebSocket } from "ws"
import { accountFor, type Role } from "../../../scripts/roles"
import { ArkivRobotNet } from "./arkivNet"
import { DevPlanner, type Planner, ZeroGPlanner } from "./planner"
import { RobotRuntime } from "./robot"
import { loadSoftware, type PolicyVersion } from "./software"
import { fileStore, readRun } from "./store"

const PORT = Number(process.env.FLEET_PORT ?? 8787)
const FRAME_MS = 66
const PHYSICS_MS = 20
const STEPS_PER_MS = 0.5 // 2 ms of simulated time per physics step
const MAX_STEPS = 100

const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const model = process.env.ZG_MODEL || "glm-5.2"
const run = readRun()
if (!run) throw new Error("No demo run found. Run: npm run seed")

function makePlanner(): { planner: Planner; source: "0g" | "dev" } {
  const key = process.env.ZG_API_KEY
  if (key) return { planner: new ZeroGPlanner(key, model), source: "0g" }
  // Never a silent fallback: without a key the robots refuse to start unless development mode was asked for.
  if (process.env.DEV_PLANNER === "1") return { planner: new DevPlanner(), source: "dev" }
  throw new Error("ZG_API_KEY is missing. Add it to .env, or set DEV_PLANNER=1 for local development only.")
}

const { planner, source: plannerSource } = makePlanner()
const client = arkivPublicClient(accessKey)
const trust = fleetTrust()
const timers = DEMO_TIMERS
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))
const version = (v: PolicyVersion) => loadSoftware(v, run.salt, model)

const mujoco = await loadMujoco()

const ROBOTS: { id: number; role: Role; autoUpdate: boolean }[] = [
  { id: 1, role: "robot1", autoUpdate: true },
  { id: 2, role: "robot2", autoUpdate: true },
  // Robot 3 stays on the old software until someone installs the fix, which the demo needs to show.
  { id: 3, role: "robot3", autoUpdate: false },
]

const robots = await Promise.all(
  ROBOTS.map(async ({ id, role, autoUpdate }) => {
    const w = writer(role)
    const latest = await readLatestLoadout(client, w.address)
    const robot = new RobotRuntime({
      id,
      address: w.address,
      sim: new RobotSim(mujoco),
      net: new ArkivRobotNet(client, w, trust, timers.heartbeatTtlSeconds),
      planner,
      trust,
      timers,
      store: fileStore(`gate-${id}-${run.salt}.json`),
      software: version("1.5.2"),
      loadVersion: version,
      autoUpdate,
      startSeq: (latest?.seq ?? 0n) + 1n,
    })
    await robot.start()
    return robot
  }),
)

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args)

// Physics runs in real time, with a cap so a stall never makes a robot lurch.
let lastPhysics = Date.now()
let carry = 0
setInterval(() => {
  const now = Date.now()
  carry += (now - lastPhysics) * STEPS_PER_MS
  lastPhysics = now
  const steps = Math.min(Math.floor(carry), MAX_STEPS)
  carry = steps === MAX_STEPS ? 0 : carry - steps
  if (steps > 0) for (const r of robots) r.pump(steps)
}, PHYSICS_MS)

// Gate checks and heartbeats are spread out, so the robots do not all hit the network at once.
robots.forEach((r, i) => {
  setTimeout(() => {
    setInterval(() => {
      const before = r.status
      r.checkGate()
        .then(() => {
          if (r.status !== before) log(`robot ${r.id}: ${before} -> ${r.status}`)
        })
        .catch((e) => log(`robot ${r.id} check failed`, e))
    }, timers.checkIntervalMs)
  }, (timers.checkIntervalMs / robots.length) * i)
  setTimeout(() => {
    setInterval(() => void r.beat(), timers.heartbeatIntervalMs)
  }, (timers.heartbeatIntervalMs / robots.length) * i)
})

function snapshot() {
  return {
    salt: run!.salt,
    plannerSource,
    model,
    timers,
    recalledHash: version("1.5.2").policyHash,
    fixedHash: version("1.5.3").policyHash,
    robots: robots.map((r) => ({
      id: r.id,
      address: r.address,
      status: r.status,
      gateMode: r.gateMode,
      online: r.networkUp,
      plannerUp: r.plannerEnabled,
      version: r.software.version,
      seq: r.seq,
      files: r.software.files,
      decisions: r.decisions.length,
      lastDecision: r.decisions[r.decisions.length - 1],
      block: r.lastCheck?.block,
      advisories: r.lastCheck?.advisories.map((a) => ({
        key: a.recall.key,
        confirms: a.confirms,
        disputes: a.disputes,
        effective: a.effective,
      })),
      vanished: r.lastCheck?.vanished.map((v) => v.key),
      lastError: r.lastError,
    })),
  }
}

const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  })
  res.end(stringify(body))
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
}

const maker = writer("maker")
const regulator = writer("regulator")
const outsider = writer("outsider")

const routes: Record<string, (body: any, match: RegExpMatchArray) => Promise<unknown>> = {
  "GET /api/state": async () => snapshot(),

  "GET /api/robots/(\\d+)/episode": async (_b, m) => {
    const r = robots.find((x) => x.id === Number(m[1]))
    if (!r) throw new Error("no such robot")
    return { robot: r.address, salt: run!.salt, events: r.events, decisions: r.decisions }
  },

  "POST /api/robots/(\\d+)/network": async (b, m) => {
    const r = robots.find((x) => x.id === Number(m[1]))
    if (!r) throw new Error("no such robot")
    r.setNetwork(Boolean(b.up))
    log(`robot ${r.id}: internet ${b.up ? "restored" : "cut"}`)
    return { online: r.networkUp }
  },

  "POST /api/robots/(\\d+)/update": async (_b, m) => {
    const r = robots.find((x) => x.id === Number(m[1]))
    if (!r) throw new Error("no such robot")
    return { installed: await r.installFix(), version: r.software.version, error: r.lastError }
  },

  "POST /api/planner": async (b) => {
    for (const r of robots) r.setPlanner(Boolean(b.up))
    log(`0G ${b.up ? "switched back on" : "switched off"}`)
    return { up: Boolean(b.up) }
  },

  "POST /api/maker/stop": async (b) => {
    const t0 = Date.now()
    const res = await maker.stop({
      artifact: version("1.5.2").policyHash,
      severity: b.severity ?? "HIGH",
      reason: b.reason ?? "Service interface left open in policy 1.5.2",
    })
    log(`maker STOP written in ${Date.now() - t0} ms: ${res.entityKey}`)
    return { key: res.entityKey, txHash: res.txHash, sentAt: t0 }
  },

  "POST /api/maker/fix": async (b) => {
    const res = await maker.lift({
      recall: b.recall as Hex,
      artifact: version("1.5.2").policyHash,
      kind: "FIX",
      fixedHash: version("1.5.3").policyHash,
      fixedRef: b.fixedRef,
      note: "Policy 1.5.3 closes the service interface",
    })
    log(`maker published fix: ${res.entityKey}`)
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/maker/withdraw": async (b) => {
    const res = await maker.lift({
      recall: b.recall as Hex,
      artifact: version("1.5.2").policyHash,
      kind: "WITHDRAWN",
      note: b.note ?? "Issued by mistake",
    })
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/maker/delete": async (b) => {
    const res = await maker.deleteRecord(b.recall as Hex)
    log(`maker deleted its own STOP: ${b.recall}`)
    return { txHash: res.txHash }
  },

  "POST /api/regulator/stop": async (b) => {
    const res = await regulator.stop({
      artifact: version("1.5.2").policyHash,
      severity: b.severity ?? "HIGH",
      reason: b.reason ?? "Regulator order",
    })
    return { key: res.entityKey, txHash: res.txHash }
  },

  /** Shows that a record anyone can write proves nothing: gates and pages ignore it. */
  "POST /api/outsider/fake-stop": async () => {
    const res = await outsider.stop({
      artifact: version("1.5.2").policyHash,
      severity: "HIGH",
      reason: "Fake STOP from a competitor",
    })
    return { key: res.entityKey, txHash: res.txHash }
  },
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {})
  const path = new URL(req.url ?? "/", "http://x").pathname
  for (const [route, handler] of Object.entries(routes)) {
    const [method, pattern] = route.split(" ") as [string, string]
    const match = path.match(new RegExp(`^${pattern}$`))
    if (req.method === method && match) {
      try {
        return send(res, 200, await handler(await readBody(req), match))
      } catch (e) {
        log("request failed", route, (e as Error).message.split("\n")[0])
        return send(res, 500, { error: (e as Error).message.split("\n")[0] })
      }
    }
  }
  return send(res, 404, { error: "not found" })
})

const wss = new WebSocketServer({ server, path: "/live" })
setInterval(() => {
  if (wss.clients.size === 0) return
  const frame = JSON.stringify({
    robots: robots.map((r) => ({ id: r.id, tick: r.sim.tick, status: r.status, online: r.networkUp, q: r.sim.qpos() })),
  })
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(frame)
}, FRAME_MS)

server.listen(PORT, () => log(`fleet on http://localhost:${PORT}, planner: ${plannerSource}, run ${run.salt}`))
