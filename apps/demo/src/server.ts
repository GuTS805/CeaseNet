import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import {
  ADDRESSES,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  DEMO_TIMERS,
  demoPolicy,
  type Hex,
  type LiftRow,
  readDiaries,
  readLatestLoadout,
  readRecallsBy,
  readTrustPolicy,
  type TrustPolicy,
} from "@ceasenet/core"
import {
  agentPassFromEnv,
  ArkivGuardNet,
  Diary,
  type DiaryData,
  fetchPackage,
  fileLinks,
  Guard,
  openSealedRef,
  sealRef,
  SwarmClient,
} from "@ceasenet/guard"
import { toHex } from "viem"
import { accountFor, type Role } from "../../../scripts/roles"
import { argsHash, connectWith, OfficeAgent } from "./agent"
import { ApprovalDesk } from "./approvals"
import { type Brain, DevBrain, ModelBrain, modelFromEnv, modelHost, PacedBrain } from "./brain"
import { catalog, coreFiles, SYSTEM_PROMPT, toolProcess } from "./catalog"
import { countLines, gateStore, sandboxDir, STATE_DIR } from "./store"
import { uploadPackage, uploadPublicEvidence, uploadSealedEvidence } from "./swarmFiles"
import { ZeroGStore } from "./zeroG"

const PORT = Number(process.env.DEMO_PORT ?? 8787)
/** Agents stop working when nobody has looked for this long, so a forgotten demo does not spend credits. */
const IDLE_AFTER_MS = 90_000
const DIARY_FLUSH_MS = 45_000

const accessKey = process.env.ARKIV_ACCESS_KEY ?? ""
const client = arkivPublicClient(accessKey)
const timers = DEMO_TIMERS
const tools = catalog()
const writer = (role: Role) => new ArkivWriter(arkivWalletClient(accountFor(role), accessKey))
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...args)

function makeBrain(): { brain: Brain; source: "model" | "dev"; model: string; host: string } {
  // Asked for by name only. Without a key, and without this, the demo refuses to start.
  if (process.env.DEV_BRAIN === "1") return { brain: new DevBrain(), source: "dev", model: "built-in-rules", host: "this-machine" }
  const settings = modelFromEnv()
  return {
    // The limit belongs to the key, so every agent shares one queue.
    brain: new PacedBrain(new ModelBrain(settings), 60_000 / settings.requestsPerMinute),
    source: "model",
    model: settings.model,
    host: modelHost(settings.url),
  }
}

const { brain, source: brainSource, model, host: modelSource } = makeBrain()
const diaryStore = new ZeroGStore(toHex(accountFor("treasury").getHdKey().privateKey!))

/** Reading from Swarm is free, so a gateway is enough. Uploading needs your own Bee node or service, and a postage batch. */
const SWARM_GATEWAY = process.env.SWARM_GATEWAY_URL || "https://api.gateway.ethswarm.org"
const swarm = new SwarmClient({ url: process.env.BEE_API_URL || SWARM_GATEWAY, batch: process.env.SWARM_POSTAGE_BATCH_ID || undefined })
const swarmOn = Boolean(process.env.BEE_API_URL && swarm.canUpload)
const FIXES_DIR = join(STATE_DIR, "fixes")
/** Set ahead of time, so a STOP never waits for Swarm. */
let sealedEvidence: string | undefined

interface Company {
  id: string
  company: string
  ownerRole: Role
  agentRole: Role
  autoUpdate: boolean
  firstInvoice: number
}

const COMPANIES: Company[] = [
  { id: "a", company: "Asha Exports", ownerRole: "ownerA", agentRole: "agentA", autoUpdate: true, firstInvoice: 1000 },
  { id: "b", company: "Bandra Freight", ownerRole: "ownerB", agentRole: "agentB", autoUpdate: true, firstInvoice: 2000 },
  // Coastal Foods updates by hand, which the demo needs to show.
  { id: "c", company: "Coastal Foods", ownerRole: "ownerC", agentRole: "agentC", autoUpdate: false, firstInvoice: 3000 },
]

const desk = new ApprovalDesk({ pass: agentPassFromEnv(), links: fileLinks(join(STATE_DIR, "approvers.json")) })

let lastSeen = Date.now()
const someoneWatching = () => Date.now() - lastSeen < IDLE_AFTER_MS

const toolPackages = [tools.badMail, tools.fixedMail, tools.files]

/** With a reference on the record, the fix comes from Swarm and its hash decides. Otherwise this machine has a copy. */
async function findFix(lift: LiftRow) {
  const hash = lift.fixedHash ?? ""
  if (lift.fixedRef) return { ...(await fetchPackage(swarm, lift.fixedRef, hash, FIXES_DIR)), from: "downloaded from Swarm, hash checked" }
  return toolPackages.find((p) => p.file.hash.toLowerCase() === hash.toLowerCase())
}

const fleet = await Promise.all(
  COMPANIES.map(async (c) => {
    const agentWriter = writer(c.agentRole)
    const owner = accountFor(c.ownerRole).address
    const sandbox = sandboxDir(c.id)
    const latest = await readLatestLoadout(client, agentWriter.address)
    const diaries = await readDiaries(client, agentWriter.address)
    const last = diaries[0]
    const diary = new Diary(
      diaryStore,
      agentWriter,
      Date.now,
      last ? { head: last.head as Hex, seq: Number(last.lastSeq) + 1 } : undefined,
    )
    const note = (data: DiaryData) => void diary.append(data)

    const guard = new Guard({
      policy: demoPolicy(),
      timers,
      store: gateStore(`gate-${c.id}.json`),
      files: [tools.badMail.file, tools.files.file, ...coreFiles(model, modelSource)],
      net: new ArkivGuardNet(client, owner, agentWriter, timers.heartbeatTtlSeconds),
      startSeq: (latest?.seq ?? 0n) + 1n,
      approve: desk.approverFor(c.id),
      onEvent: (e) => {
        if (e.kind === "STATUS") note({ kind: "STATUS", from: e.from, to: e.to })
        else if (e.kind === "RECEIPT") note({ kind: "RECEIPT", recall: e.recall, action: e.action })
        else if (e.kind === "NETWORK") note({ kind: "NETWORK", up: e.up })
        else if (e.kind === "UPDATE") {
          note({ kind: "UPDATE", from: e.from.version, to: e.to.version, fromHash: e.from.hash, toHash: e.to.hash })
        }
      },
    })

    const agent = new OfficeAgent({
      id: c.id,
      company: c.company,
      guard,
      brain,
      systemPrompt: SYSTEM_PROMPT,
      tools: [tools.badMail, tools.files],
      connect: connectWith(guard, (pkg) => toolProcess(pkg, sandbox, c.company)),
      findFix,
      autoUpdate: c.autoUpdate,
      finishesJob: (tool) => tool === "send_email",
      firstInvoice: c.firstInvoice,
      shouldWork: someoneWatching,
      // The built-in rules answer instantly, so they get a pause. A real model takes seconds on its own.
      turnGapMs: brainSource === "dev" ? 1_500 : 0,
      onCall: ({ file, action, args, result, requestId, model: usedModel }) => {
        note({
          kind: "CALL",
          tool: file.name,
          version: file.version,
          hash: file.hash,
          action,
          argsHash: argsHash(args),
          verdict: result.decision.verdict,
          allowed: result.decision.allowed,
          ...(result.decision.approval ? { approval: result.decision.approval } : {}),
          requestId,
          model: usedModel,
        })
      },
    })
    return { ...c, agent, guard, diary, owner, sandbox, writer: agentWriter }
  }),
)

const find = (id: string) => {
  const entry = fleet.find((f) => f.id === id)
  if (!entry) throw new Error("no such agent")
  return entry
}

const lastPolicy = new Map<string, TrustPolicy>()

async function refreshPolicies(): Promise<void> {
  for (const f of fleet) {
    const policy = await readTrustPolicy(client, f.owner).catch(() => undefined)
    if (policy) lastPolicy.set(f.id, policy)
  }
}

function snapshot() {
  return {
    brainSource,
    model,
    timers,
    tools: { bad: tools.badMail.file, fixed: tools.fixedMail.file, files: tools.files.file },
    diaryWallet: diaryStore.address,
    swarm: { on: swarmOn, evidenceReady: Boolean(sealedEvidence) },
    worldIdApprovals: desk.usesWorldId,
    idle: !someoneWatching(),
    agents: fleet.map((f) => {
      const policy = f.guard.lastCheck?.policy ?? lastPolicy.get(f.id)
      return {
        id: f.id,
        company: f.company,
        address: f.writer.address,
        owner: f.owner,
        status: f.guard.status,
        online: f.guard.networkUp,
        tools: f.guard.toolVerdicts,
        files: f.guard.files,
        followsMaker: policy ? policy.issuers.some((i) => i.toLowerCase() === ADDRESSES.maker.toLowerCase()) : undefined,
        jobs: f.agent.jobs,
        sent: countLines(f.sandbox, "sent.jsonl"),
        stolen: countLines(f.sandbox, "attacker-inbox.jsonl"),
        drafts: countLines(f.sandbox, "drafts.jsonl"),
        feed: f.agent.feed.slice(-14),
        approval: desk.view(f.id),
        approvalNote: desk.note(f.id),
        fixAvailable: (f.guard.lastCheck?.fixes.length ?? 0) > 0,
        vanished: f.guard.lastCheck?.vanished.map((v) => v.key) ?? [],
        block: f.guard.lastCheck?.block,
        diary: { entries: f.diary.size, waiting: f.diary.waiting, parts: f.diary.parts, lastError: f.diary.lastError },
        problem: f.agent.brainProblem ?? f.guard.lastError,
      }
    }),
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
const verifier = writer("verifier")

const RECALL = {
  artifact: tools.badMail.file.hash,
  severity: "CRITICAL",
  reason: "demo-mail-tool 1.0.16 secretly copies every email to a stranger",
  advice: "Treat every email sent with this version as leaked. Tell the customers affected and move to 1.0.17.",
  pkg: "demo-mail-tool",
  versions: ">=1.0.16 <1.0.17",
}

const routes: Record<string, (body: any, match: RegExpMatchArray) => Promise<unknown>> = {
  "GET /api/state": async () => {
    lastSeen = Date.now()
    return snapshot()
  },

  "POST /api/agents/(\\w+)/network": async (b, m) => {
    const f = find(m[1]!)
    f.guard.setNetwork(Boolean(b.up))
    log(`${f.company}: connection ${b.up ? "restored" : "cut"}`)
    return { online: f.guard.networkUp }
  },

  "POST /api/agents/(\\w+)/update": async (_b, m) => {
    const f = find(m[1]!)
    return { installed: await f.agent.installFix(), files: f.guard.files, error: f.guard.lastError }
  },

  /** Refuses a call. It can approve one only while World ID is not connected, as a labelled stand-in. */
  "POST /api/agents/(\\w+)/approval": async (b, m) => {
    desk.answer(m[1]!, Boolean(b.approve))
    return { answered: true }
  },

  /** Asks a real person through World ID Agent Pass. The call goes ahead only after this backend validates the result. */
  "POST /api/agents/(\\w+)/approval/world": async (_b, m) => {
    const f = find(m[1]!)
    return desk.startPass(f.id, f.owner)
  },

  /** An owner changes whose STOPs their agents obey. It is public, and takes effect at the next check. */
  "POST /api/owners/(\\w+)/follow-maker": async (b, m) => {
    const f = find(m[1]!)
    const current = (await readTrustPolicy(client, f.owner)) ?? demoPolicy()
    const others = current.issuers.filter((i) => i.toLowerCase() !== ADDRESSES.maker.toLowerCase())
    const policy = { ...current, issuers: b.follow ? [ADDRESSES.maker, ...others] : others }
    const seq = BigInt(Date.now())
    const res = await writer(f.ownerRole).trustList({ seq, policy })
    log(`${f.company} now ${b.follow ? "follows" : "does not follow"} the maker`)
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/maker/stop": async () => {
    const t0 = Date.now()
    const res = await maker.stop({ ...RECALL, sealedEvidence })
    log(`maker STOP written in ${Date.now() - t0} ms: ${res.entityKey}`)
    return { key: res.entityKey, txHash: res.txHash, sentAt: t0 }
  },

  "POST /api/maker/fix": async (b) => {
    const fixedRef = swarmOn ? await uploadPackage(swarm, tools.fixedMail) : undefined
    const res = await maker.lift({
      recall: b.recall as Hex,
      artifact: tools.badMail.file.hash,
      kind: "FIX",
      fixedRef,
      fixedHash: tools.fixedMail.file.hash,
      fixedVersion: tools.fixedMail.file.version,
      note: "demo-mail-tool 1.0.17 removes the hidden copy",
    })
    log(`maker published the fix: ${res.entityKey}`)
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/maker/withdraw": async (b) => {
    const res = await maker.lift({
      recall: b.recall as Hex,
      artifact: tools.badMail.file.hash,
      kind: "WITHDRAWN",
      note: b.note ?? "Issued by mistake",
    })
    return { key: res.entityKey, txHash: res.txHash }
  },

  /** A maker tries to erase its own recall. Agents keep obeying, and their receipts keep the proof. */
  "POST /api/maker/delete": async (b) => {
    const res = await maker.deleteRecord(b.recall as Hex)
    log(`maker deleted its own STOP: ${b.recall}`)
    return { txHash: res.txHash }
  },

  /** Only the key the evidence was sealed to can do this, and only here: the server holds that key for the demo. */
  "POST /api/regulator/open-evidence": async (b) => {
    const { rows } = await readRecallsBy(client, [ADDRESSES.maker, ADDRESSES.regulator])
    const recall = rows.find((r) => r.key === b.recall)
    if (!recall?.sealedEvidence) throw new Error("this recall has no sealed evidence")
    const reference = openSealedRef(recall.sealedEvidence, toHex(accountFor("regulator").getHdKey().privateKey!))
    return { evidence: new TextDecoder().decode(await swarm.read(reference)) }
  },

  /** The disclosure deadline has passed: the description and evidence become public. */
  "POST /api/maker/disclose": async (b) => {
    const reproductionRef = swarmOn ? await uploadPublicEvidence(swarm, tools.badMail) : undefined
    const res = await maker.disclose({
      recall: b.recall as Hex,
      description: "demo-mail-tool 1.0.16 copied every email it sent to an address nobody asked for. Version 1.0.17 removes the copy.",
      reproductionRef,
    })
    log(`maker disclosed: ${res.entityKey}`)
    return { key: res.entityKey, txHash: res.txHash, reproductionRef }
  },

  "POST /api/regulator/stop": async () => {
    const res = await regulator.stop(RECALL)
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/regulator/dismiss": async (b) => {
    const res = await regulator.lift({ recall: b.recall as Hex, artifact: tools.badMail.file.hash, kind: "DISMISSED" })
    return { key: res.entityKey, txHash: res.txHash }
  },

  /** Shows that a record anyone can write proves nothing: gates and pages ignore it. */
  "POST /api/outsider/fake-stop": async () => {
    const res = await outsider.stop({
      artifact: tools.badMail.file.hash,
      severity: "CRITICAL",
      reason: "Fake STOP from a competitor",
    })
    return { key: res.entityKey, txHash: res.txHash }
  },

  /** A warning, as the verifier files it once a researcher or scanner has passed its checks. */
  "POST /api/lab/warning": async () => {
    const res = await verifier.advisory({
      artifact: tools.badMail.file.hash,
      severity: "HIGH",
      reason: "A scanner found demo-mail-tool 1.0.16 sending mail to an address nobody asked for",
      pkg: RECALL.pkg,
      versions: RECALL.versions,
    })
    return { key: res.entityKey, txHash: res.txHash }
  },

  /** Stands in for one verified person confirming, until the verifier service is connected. */
  "POST /api/lab/confirm": async (b) => {
    const res = await verifier.endorse({ recall: b.recall as Hex, stance: "CONFIRM", human: `demo-${String(b.human)}` })
    return { key: res.entityKey, txHash: res.txHash }
  },

  "POST /api/diary/flush": async () => {
    await Promise.all(fleet.map((f) => f.diary.flush()))
    return fleet.map((f) => ({ id: f.id, parts: f.diary.parts, waiting: f.diary.waiting, error: f.diary.lastError }))
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

/** Stores the files ahead of time. If Swarm is unreachable the demo still runs, and says so. */
async function prepareSwarm(): Promise<void> {
  if (!swarmOn) return log("Swarm is off: set BEE_API_URL and SWARM_POSTAGE_BATCH_ID to keep fixes and evidence there")
  try {
    const [fix, evidence] = await Promise.all([uploadPackage(swarm, tools.fixedMail), uploadSealedEvidence(swarm, tools.badMail)])
    sealedEvidence = sealRef(evidence, accountFor("regulator").publicKey)
    log(`Swarm ready. The fix is at ${fix}. The evidence is encrypted, and its reference is only ever shown sealed.`)
  } catch (e) {
    log(`Swarm is not ready: ${(e as Error).message.split("\n")[0]}`)
  }
}

void prepareSwarm()
await refreshPolicies()
await Promise.all(fleet.map((f) => f.agent.start()))
fleet.forEach((f, i) => {
  // Spread out, so the agents do not all hit the network at once.
  f.guard.run((timers.checkIntervalMs / fleet.length) * i)
})
setInterval(() => {
  for (const f of fleet) void f.diary.flush()
}, DIARY_FLUSH_MS)

server.listen(PORT, () => log(`demo on http://localhost:${PORT}, model: ${brainSource} ${model}, diary wallet ${diaryStore.address}`))

const shutdown = async () => {
  server.close()
  await Promise.allSettled(fleet.map((f) => f.agent.stop()))
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
