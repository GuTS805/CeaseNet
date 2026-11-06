import { spawn } from "node:child_process"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { dirname, extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  agentArtifact,
  fleetArtifact,
  type Hex,
  identityFiles,
  isKillRecall,
  type LoadedFile,
  PRODUCTION_TIMERS,
  recallCovers,
} from "@ceasenet/core"
import { type ApprovalResult, fileStore, Guard, writeAtomic } from "@ceasenet/guard"
import {
  currentPolicy,
  enrollAgent,
  explainWriteError,
  isEnded,
  liftRecall,
  publishIdentity,
  setFollowing,
  stopAgent,
  stopFleet,
  stopTeam,
  stopTool,
} from "./actions"
import { type CallRecord, type GuardStatus, liveGuards, recentCalls } from "./activity"
import { daemonBuild, selfCommand } from "./daemonClient"
import { markWatched, memberView, shutDownMember, TEAM } from "./fleet"
import { inHome, loadConfig, loadHolds, loadKeys, type Network, nudge, saveConfig, setHold, startingPolicy } from "./home"
import { formatBalance, ledgerFor } from "./ledger"
import { claudeCodePresent, hasStopHook, inspectAll, knownClientFiles } from "./protect"
import { recordsService } from "./recordsApi"
import { type ArkivView, makeArkivClient, readArkiv, readServices, type ServiceCard } from "./services"
import { readSettings } from "./settings"
import { teamRoutes } from "./teamApi"

const APPROVAL_MS = 120_000
const STATE_REFRESH_MS = 5_000
const SLOW_REFRESH_MS = 30_000
const PUBLISH_RETRY_MS = 30_000
const BALANCE_KEEP_RATIO = 4n
const REPORT_ERROR_SHOWS_MS = 2 * 60_000
/** With no guards running and nobody at the console for this long, the background service leaves. */
const IDLE_EXIT_MS = 10 * 60_000
/** Each of these pages reads several things from the network, so an answer is kept for a moment. */
const ARKIV_CACHE_MS = 20_000
const SERVICES_CACHE_MS = 20_000
/** Another copy of this program is leaving, and needs a moment to let go of the port. */
const PORT_RETRY_MS = 250
const PORT_RETRIES = 40

interface PendingApproval {
  id: string
  server: string
  tool: string
  version: string
  action: string
  reason: string
  details?: string
  since: number
  expiresAt: number
  answer: (result: ApprovalResult) => void
}

/** What a tool's row shows. One tool may be in use by several clients, so guards are gathered by file. */
export interface ToolRow {
  name: string
  version: string
  hash: string
  strength: GuardStatus["strength"]
  servers: string[]
  guards: number
  toolPids: number[]
  mode: GuardStatus["mode"]
  online: boolean
  recall?: GuardStatus["recall"]
  blockedLocally?: string
  held: boolean
  calls: number
  refused: number
  lastCallAt?: number
}

export function toolRows(guards: readonly GuardStatus[], calls: readonly CallRecord[], holds: readonly string[]): ToolRow[] {
  const byHash = new Map<string, GuardStatus[]>()
  for (const g of guards) byHash.set(g.file.hash, [...(byHash.get(g.file.hash) ?? []), g])
  const rank = { BLOCK: 2, NEEDS_APPROVAL: 1, ALLOW: 0 }
  return [...byHash.values()]
    .map((group) => {
      const first = group[0]!
      const mine = calls.filter((c) => c.tool === first.file.name && c.version === first.file.version)
      return {
        name: first.file.name,
        version: first.file.version,
        hash: first.file.hash,
        strength: first.strength,
        servers: [...new Set(group.map((g) => g.server))],
        guards: group.length,
        toolPids: group.flatMap((g) => (g.toolPid ? [g.toolPid] : [])),
        // The strictest guard speaks for the tool.
        mode: group.map((g) => g.mode).sort((a, b) => rank[b] - rank[a])[0]!,
        online: group.every((g) => g.online),
        recall: group.find((g) => g.recall)?.recall,
        blockedLocally: group.find((g) => g.blockedLocally)?.blockedLocally,
        held: holds.includes(first.file.name),
        calls: mine.length,
        refused: mine.filter((c) => !c.allowed).length,
        lastCallAt: mine[0]?.at,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".json": "application/json",
}

/** The console's built pages: beside the installed program, or in the repository while developing. */
function pagesDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, "console"), join(here, "..", "..", "..", "apps", "console", "dist")].find((d) => existsSync(join(d, "index.html")))
}

const stringify = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface DaemonHandle {
  server: Server
  port: number
  token: string
  close(): Promise<void>
}

export interface DaemonOptions {
  port?: number
  /** Stay running even with no guards and nobody watching. */
  stay?: boolean
  /** An older console is on its way out, so wait for the port rather than give up on it. */
  waitForPort?: boolean
}

/**
 * The one process on a machine that writes for its agent, and the console on top of it.
 *
 * Guards never need it to decide anything. It only reports what they do: the agent's loadout, its heartbeat and
 * its receipts all come from one place, because transactions from one key must go out one at a time.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const config = loadConfig()
  const ledger = ledgerFor(config)
  const token = randomBytes(24).toString("hex")
  let port = options.port ?? config.port
  const owner = config.owner.address
  const agentAddress = config.agent.address
  const keys = loadKeys()

  const approvals = new Map<string, PendingApproval>()
  const problems = new Map<string, string>()
  const notes: { at: number; text: string }[] = []
  const note = (text: string) => {
    notes.unshift({ at: Date.now(), text })
    notes.length = Math.min(notes.length, 30)
  }
  let lastWatched = Date.now()
  /** Writing costs money. With none, public reports wait, which the console says once rather than as a stream of errors. */
  let agentEmpty = false
  let ownerEmpty = false
  const reportProblem = (key: string, e: unknown) => {
    if (agentEmpty) problems.delete(key)
    else problems.set(key, explainWriteError(e, agentAddress).message)
  }

  // ---- Reporting what this agent does ----

  const identity = identityFiles(agentAddress, owner)
  const reporter = new Guard({
    policy: await currentPolicy(ledger, config).catch(() => startingPolicy(owner)),
    timers: PRODUCTION_TIMERS,
    store: fileStore(inHome("gates", "_reporter.json")),
    files: identity,
    net: ledger.agentNet(keys.agent, PRODUCTION_TIMERS.heartbeatTtlSeconds),
    startSeq: BigInt(Date.now()),
  })

  let reportedFiles = ""
  const syncLoadout = async () => {
    const files = new Map<string, LoadedFile>()
    for (const g of liveGuards()) files.set(g.file.hash, g.file)
    const list = [...files.values()].sort((a, b) => a.hash.localeCompare(b.hash))
    const key = list.map((f) => f.hash).join()
    if (key === reportedFiles) return
    reportedFiles = key
    try {
      await reporter.setFiles([...list, ...identity])
      problems.delete("loadout")
    } catch (e) {
      reportedFiles = ""
      reportProblem("loadout", e)
    }
  }

  /** Keeps the agent's wallet in funds from the owner's, so an owner has one address to think about. */
  const topUpAgent = async () => {
    if (ledger.kind !== "arkiv" || !keys.owner) return
    const [mine, its] = await Promise.all([ledger.balance(owner), ledger.balance(agentAddress)])
    if (!mine || its === undefined || its * BALANCE_KEEP_RATIO >= mine) return
    const amount = mine / BALANCE_KEEP_RATIO
    await ledger.writer(keys.owner).send(agentAddress, amount)
    note(`Sent ${formatBalance(amount)} tGLM from the owner's wallet to the agent's, to pay for its receipts.`)
  }

  let identityDone = !keys.owner
  const maintain = async () => {
    // Nothing can be published without funds. The console says what to do, so trying would only add noise.
    if (ownerEmpty) return
    try {
      await topUpAgent()
      if (!identityDone) {
        for (const line of await publishIdentity(ledger, config)) note(`Done: ${line}.`)
        identityDone = true
      }
      problems.delete("funds")
    } catch (e) {
      problems.set("funds", explainWriteError(e, owner).message)
    }
  }

  // ---- What the console shows ----

  let slowState: Record<string, unknown> = {}
  const refreshSlow = async () => {
    try {
      const [ownerBalance, agentBalance, policy, passports] = await Promise.all([
        ledger.balance(owner),
        ledger.balance(agentAddress),
        currentPolicy(ledger, config),
        ledger.agents(owner),
      ])
      const fleet = await Promise.all(
        [...new Map([...passports.map((p) => [p.agent.toLowerCase(), p] as const)]).values()].map(async (p) => {
          const [heartbeat, loadout] = await Promise.all([ledger.heartbeat(p.agent), ledger.loadout(p.agent)])
          return {
            agent: p.agent,
            name: p.name,
            status: heartbeat?.mode,
            tools: (loadout?.files ?? []).filter((f) => f.kind === "tool" || f.kind === "skill"),
          }
        }),
      )
      agentEmpty = agentBalance === 0n
      ownerEmpty = ownerBalance === 0n
      slowState = {
        funds: ownerBalance === undefined ? undefined : { owner: formatBalance(ownerBalance), agent: formatBalance(agentBalance ?? 0n), ownerEmpty, agentEmpty },
        trust: policy,
        fleet,
      }
      problems.delete("read")
    } catch (e) {
      problems.set("read", `Cannot read the list right now: ${(e as Error).message.split("\n")[0]}`)
    }
  }

  /** The team's agents, by address, for naming them in the list of recalls. */
  const teamNames = () => new Map(TEAM.flatMap((m) => {
    const address = memberView(m).address
    return address ? [[address.toLowerCase(), m.name] as const] : []
  }))

  let recallState: Record<string, unknown> = {}
  const refreshRecalls = async () => {
    try {
      const policy = (slowState.trust as Awaited<ReturnType<typeof currentPolicy>>) ?? (await currentPolicy(ledger, config))
      const { rows, block } = await ledger.recalls([...new Set([...policy.issuers, owner])])
      const keysOf = rows.map((r) => r.key)
      const [lifts, acks] = await Promise.all([ledger.lifts(keysOf), ledger.acks(keysOf)])
      const fileList = [...new Map(liveGuards().map((g) => [g.file.hash, g.file])).values()]
      recallState = {
        block,
        recalls: rows
          .map((r) => ({
            ...r,
            ended: isEnded(r, lifts, policy),
            fix: lifts.find((l) => l.recall === r.key && l.kind === "FIX"),
            mine: r.creator.toLowerCase() === owner.toLowerCase(),
            kill: isKillRecall(r.artifact),
            target:
              r.artifact === agentArtifact(agentAddress)
                ? "this agent"
                : r.artifact === fleetArtifact(owner)
                  ? "all your agents"
                  : r.artifact.startsWith("team:")
                    ? "the team of three agents"
                    : isKillRecall(r.artifact)
                    ? (teamNames().get(r.artifact.slice(6)) ?? `agent ${r.artifact.slice(6)}`)
                    : (fileList.find((f) => recallCovers(r, f))?.name ?? r.pkg ?? r.artifact),
            affectsMe: fileList.some((f) => recallCovers(r, f)) || r.artifact === agentArtifact(agentAddress) || r.artifact === fleetArtifact(owner),
            receipts: acks.filter((a) => a.recall === r.key && a.creator.toLowerCase() === a.agent.toLowerCase()).length,
            myReceipt: acks.some((a) => a.recall === r.key && a.agent.toLowerCase() === agentAddress.toLowerCase()),
            receiptAgents: acks.filter((a) => a.recall === r.key && a.creator.toLowerCase() === a.agent.toLowerCase()).map((a) => a.agent.toLowerCase()),
          }))
          .sort((a, b) => Number(b.createdAt - a.createdAt)),
      }
      problems.delete("recalls")
    } catch (e) {
      problems.set("recalls", `Cannot read recalls right now: ${(e as Error).message.split("\n")[0]}`)
    }
  }

  const clients = () =>
    inspectAll(knownClientFiles()).map((f) => ({
      client: f.client,
      path: f.path,
      problem: f.problem,
      protected: f.servers.filter((s) => s.state === "protected").map((s) => s.name),
      unprotected: f.servers.filter((s) => s.state === "unprotected").map((s) => s.name),
      remote: f.servers.filter((s) => s.state === "remote").map((s) => s.name),
    }))

  // Set once the requests below are defined, which this needs for issuing recalls.
  let records: ReturnType<typeof recordsService>
  const snapshot = () => {
    const guards = liveGuards()
    const calls = recentCalls(200)
    const agentStop = (recallState.recalls as { artifact: string; ended: boolean; reason: string; key: string; createdAt: bigint }[] | undefined)?.find(
      (r) => !r.ended && (r.artifact === agentArtifact(agentAddress) || r.artifact === fleetArtifact(owner)),
    )
    return {
      network: ledger.kind,
      agent: { ...config.agent, status: reporter.status },
      owner: { address: owner, canSign: Boolean(keys.owner) },
      stoppedBy: agentStop,
      tools: toolRows(guards, calls, loadHolds()),
      guardsRunning: guards.length,
      calls: calls.slice(0, 60),
      approvals: [...approvals.values()].map(({ answer: _answer, ...view }) => view),
      problems: [...problems.values()],
      notes,
      clients: clients(),
      reportsWaiting: records.waiting(),
      claudeCode: { present: claudeCodePresent(), covered: hasStopHook() },
      ...slowState,
      ...recallState,
    }
  }

  // ---- Requests ----

  const refreshAfterChange = async () => {
    nudge()
    await Promise.allSettled([refreshSlow(), refreshRecalls(), reporter.check(true)])
  }

  /** When Stop was pressed for each recall, so closing can be timed from what a person actually did. */
  const pressed = new Map<string, number>()
  const timed = async (issue: () => Promise<{ entityKey: Hex }>) => {
    const at = Date.now()
    const result = await issue()
    pressed.set(result.entityKey, at)
    await refreshAfterChange()
    return result
  }

  const arkivClient = makeArkivClient(config)
  records = recordsService({ config, ledger, keys, client: arkivClient, timed })
  let arkivCache: { at: number; view: Promise<ArkivView> } | undefined
  let servicesCache: { at: number; cards: Promise<ServiceCard[]> } | undefined

  type Route = (body: Record<string, any>, match: RegExpMatchArray, res: ServerResponse) => Promise<unknown> | unknown
  const routes: Record<string, Route> = {
    "GET /api/health": () => ({ ok: true, build: daemonBuild() }),
    "GET /api/state": () => {
      lastWatched = Date.now()
      // Any page of the console counts as someone watching the agents.
      markWatched()
      return snapshot()
    },
    ...(records.routes as Record<string, Route>),
    ...(teamRoutes({
      config,
      ledger,
      keys,
      pressed,
      recalls: () => (recallState.recalls as never) ?? [],
      block: () => recallState.block as string | undefined,
    }) as Record<string, Route>),
    "POST /api/team/stop": (b) => timed(() => stopTeam(ledger, config, String(b.reason ?? ""))),
    "GET /api/arkiv": () => {
      lastWatched = Date.now()
      if (!arkivCache || Date.now() - arkivCache.at > ARKIV_CACHE_MS) {
        const agents = TEAM.flatMap((m) => {
          const address = memberView(m).address
          return address ? [{ name: m.name, address }] : []
        })
        arkivCache = { at: Date.now(), view: readArkiv({ config, ledger, client: arkivClient, agents }) }
      }
      return arkivCache.view
    },
    "GET /api/services": () => {
      lastWatched = Date.now()
      if (!servicesCache || Date.now() - servicesCache.at > SERVICES_CACHE_MS) {
        servicesCache = { at: Date.now(), cards: readServices(config, { ...readSettings(), ...process.env }) }
      }
      return servicesCache.cards
    },
    /** Moves to the public list, or back. Everything reading the old one has to start again to follow. */
    "POST /api/network": async (b) => {
      const network = String(b.network) as Network
      if (network !== "arkiv" && network !== "local") throw new HttpError(400, "That is not a list.")
      for (const m of TEAM) shutDownMember(m)
      saveConfig({ ...config, network })
      const self = selfCommand()
      spawn(self.command, [...self.args, "daemon", "--stay", "--wait-port"], { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true }).unref()
      setTimeout(() => process.exit(0), 200)
      return { network }
    },
    "POST /api/stop": (b) => timed(() => stopTool(ledger, config, { hash: b.hash, name: b.name, versions: b.versions, reason: String(b.reason ?? ""), severity: b.severity, advice: b.advice })),
    "POST /api/kill": (b) => {
      const reason = String(b.reason ?? "")
      return timed(() => (b.all ? stopFleet(ledger, config, reason) : stopAgent(ledger, config, String(b.agent ?? agentAddress), reason)))
    },
    "POST /api/lift": async (b) => {
      const result = await liftRecall(ledger, config, b.recall as Hex, b.note)
      await refreshAfterChange()
      return result
    },
    "POST /api/follow": async (b) => {
      const policy = await setFollowing(ledger, config, String(b.address ?? ""), Boolean(b.follow))
      await refreshAfterChange()
      return policy
    },
    "POST /api/enroll": async (b) => {
      const result = await enrollAgent(ledger, config, b.agent as Hex, String(b.name ?? "Agent"))
      await refreshAfterChange()
      return result
    },
    "POST /api/hold": (b) => ({ holds: setHold(String(b.tool ?? ""), Boolean(b.hold)) }),
    /** From a guard. The answer comes back when a person gives one, or the time runs out. */
    "POST /api/approvals": (b, _m, res) =>
      new Promise((resolve) => {
        const id = randomUUID()
        const finish = (result: ApprovalResult) => {
          if (!approvals.delete(id)) return
          clearTimeout(timer)
          resolve({ result })
        }
        const timer = setTimeout(() => finish("EXPIRED"), APPROVAL_MS)
        // The guard gave up, perhaps because a STOP arrived. Nobody should be asked about a call that is over.
        res.on("close", () => finish("EXPIRED"))
        approvals.set(id, {
          id,
          server: String(b.server),
          tool: String(b.tool),
          version: String(b.version),
          action: String(b.action),
          reason: String(b.reason),
          details: b.details,
          since: Date.now(),
          expiresAt: Date.now() + APPROVAL_MS,
          answer: finish,
        })
      }),
    "POST /api/approvals/([\\w-]+)": (b, m) => {
      const pending = approvals.get(m[1]!)
      if (!pending) throw new HttpError(404, "That call is no longer waiting.")
      pending.answer(b.approve ? "APPROVED" : "DENIED")
      return { answered: true }
    },
  }

  const tokenMatches = (given: string | undefined): boolean => {
    if (!given || given.length !== token.length) return false
    return timingSafeEqual(Buffer.from(given), Buffer.from(token))
  }

  const respond = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    res.end(stringify(body))
  }

  const pages = pagesDir()
  const servePage = (path: string, res: ServerResponse) => {
    if (!pages) {
      res.writeHead(500, { "content-type": "text/plain" })
      res.end("The console's pages have not been built. Run: npm run build -w ceasenet")
      return
    }
    const wanted = normalize(join(pages, path === "/" ? "index.html" : decodeURIComponent(path)))
    // The token goes only into the page itself, and only a page from this address can read that.
    const file = wanted.startsWith(pages + sep) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(pages, "index.html")
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream"
    if (file.endsWith("index.html")) {
      const html = readFileSync(file, "utf8").replace("__CEASENET_TOKEN__", token)
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" })
      res.end(html)
      return
    }
    res.writeHead(200, { "content-type": type })
    res.end(readFileSync(file))
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // A web page can send requests to this machine. Only requests that name this machine are answered at all,
    // which stops a hostile site pointing its own name here, and every action needs the token.
    const host = req.headers.host ?? ""
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return respond(res, 403, { error: "This console only answers on this machine." })

    const url = new URL(req.url ?? "/", "http://x")
    const path = url.pathname
    if (!path.startsWith("/api/")) return servePage(path, res)

    const given = req.headers["x-ceasenet-token"]
    if (!tokenMatches(Array.isArray(given) ? given[0] : given)) return respond(res, 401, { error: "Open the console from ceasenet console." })

    for (const [route, handler] of Object.entries(routes)) {
      const [method, pattern] = route.split(" ") as [string, string]
      const match = path.match(new RegExp(`^${pattern}$`))
      if (req.method !== method || !match) continue
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        // A request with no body, such as a GET, passes its options in the address instead.
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : (Object.fromEntries(url.searchParams) as Record<string, unknown>)
        return respond(res, 200, await handler(body, match, res))
      } catch (e) {
        return respond(res, e instanceof HttpError ? e.status : 400, { error: (e as Error).message })
      }
    }
    return respond(res, 404, { error: "Not found." })
  })

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject)
        resolve()
      })
    })
  for (let attempt = 0; ; attempt++) {
    try {
      await listen()
      break
    } catch (e) {
      if (!options.waitForPort || (e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= PORT_RETRIES) throw e
      await new Promise((r) => setTimeout(r, PORT_RETRY_MS))
    }
  }
  // Port 0 asks the system to pick one, and requests must name the one it picked.
  port = (server.address() as { port: number }).port
  writeAtomic(inHome("daemon.json"), JSON.stringify({ pid: process.pid, port, token }))

  // ---- Running ----

  await refreshSlow()
  try {
    await reporter.start()
  } catch (e) {
    // It cannot write yet, which is normal before it has funds. It can still read.
    reportProblem("loadout", e)
    await reporter.check(true)
  }
  let lastReportError = 0
  reporter.onChecked(() => {
    const error = reporter.lastError
    if (error) {
      reportProblem("report", new Error(error))
      reporter.lastError = undefined
      lastReportError = Date.now()
    } else if (Date.now() - lastReportError > REPORT_ERROR_SHOWS_MS) {
      problems.delete("report")
    }
  })
  const stopReporter = reporter.run()
  await syncLoadout()
  void maintain()
  void refreshRecalls()

  const timers = [
    setInterval(() => void syncLoadout(), STATE_REFRESH_MS),
    // Reads cost part of an access key's quota, and gates need it more than this page does. Pressing a button refreshes at once.
    setInterval(() => void refreshRecalls(), ledger.kind === "local" ? STATE_REFRESH_MS : SLOW_REFRESH_MS),
    setInterval(() => void refreshSlow(), SLOW_REFRESH_MS),
    setInterval(() => void maintain(), PUBLISH_RETRY_MS),
    setInterval(() => {
      if (options.stay) return
      if (liveGuards().length === 0 && !TEAM.some((m) => memberView(m).alive) && Date.now() - lastWatched > IDLE_EXIT_MS) process.exit(0)
    }, 30_000),
  ]

  return {
    server,
    port,
    token,
    close: async () => {
      timers.forEach(clearInterval)
      records.close()
      stopReporter()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

