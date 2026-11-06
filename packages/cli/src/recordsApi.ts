import { join } from "node:path"
import { ADDRESSES, type ArkivPublic, type DiaryRow, type Hex, identityFiles, type LoadedFile, readReports, SEALED_ON_SWARM, teamFile } from "@ceasenet/core"
import { type DiaryStore, SwarmClient } from "@ceasenet/guard"
import { privateKeyToAccount } from "viem/accounts"
import { explainWriteError, stopAgent, stopTool } from "./actions"
import { liveGuards } from "./activity"
import { type DiaryMode, type DiaryPartView, type DiaryTarget, hasWaiting, localDiaryStore, readBack, readDiaryState, sealedSwarmStore, storeWaiting, waitingCount } from "./diaryService"
import { memberHome, memberView, readAgentState, TEAM } from "./fleet"
import { type Config, homeDir, identityOf, type Keys } from "./home"
import type { Ledger } from "./ledger"
import { DEFAULT_VOTES_NEEDED, loadHandled, markHandled, type OwnAgent, recallReasonFor, reportsFor, type ReportView } from "./reports"
import { readSettings } from "./settings"

/** One stored part per agent every this often. Each one costs a little, and an agent can make many calls a minute. */
const STORE_EVERY_MS = 2 * 60_000
const TICK_MS = 10_000
const REPORTS_EVERY_MS = 30_000
/** Enough for about one part. Below this, trying would only fail. */
const LOW_ZERO_G = 2_000_000_000_000_000n
const ZERO_G_FAUCET = "https://faucet.0g.ai"
const SWARM_GATEWAY = "https://api.gateway.ethswarm.org"

interface ZeroGLike extends DiaryStore {
  address: string
  balance(): Promise<bigint>
}

/** The storage library prints as it goes, which would land in the middle of someone's terminal. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = console.log
  console.log = () => undefined
  try {
    return await work()
  } finally {
    console.log = log
  }
}

export interface RecordsContext {
  config: Config
  ledger: Ledger
  keys: Keys
  client: ArkivPublic
  /** Issues a recall the way the console's own buttons do, timed from when it was asked for. */
  timed: (issue: () => Promise<{ entityKey: Hex }>) => Promise<{ entityKey: Hex }>
}

const shortError = (e: unknown) => (e as Error).message.split("\n")[0] ?? "it failed"

/** Saving what agents did, reading it back, and telling an owner when people have reported one of them. */
export function recordsService(ctx: RecordsContext) {
  const { config, ledger, keys, client } = ctx
  const owner = config.owner.address
  const onChain = ledger.kind === "arkiv"
  const payerKey = keys.owner ?? keys.agent
  const ownerPublicKey = keys.owner ? privateKeyToAccount(keys.owner).publicKey : undefined

  // ---- Where diaries go ----

  const local = localDiaryStore(join(homeDir(), "diary-store"))
  let zeroG: Promise<ZeroGLike> | undefined
  const openZeroG = (): Promise<ZeroGLike> => {
    // Loaded only when something needs it, because it is large and a guard or hook never does.
    zeroG ??= import("@ceasenet/demo/zeroG").then(({ ZeroGStore }) => new ZeroGStore(payerKey))
    return zeroG
  }
  /** Swarm, if this machine can upload to it and can encrypt for the owner. It reads its settings each time, so setting it up needs no restart. */
  const swarmStore = (): DiaryStore | undefined => {
    const { BEE_API_URL: url, SWARM_POSTAGE_BATCH_ID: batch } = readSettings()
    return onChain && url && batch && ownerPublicKey ? sealedSwarmStore(new SwarmClient({ url, batch }), ownerPublicKey) : undefined
  }
  const readFromSwarm = (root: string): Promise<Uint8Array> => {
    const settings = readSettings()
    return new SwarmClient({ url: settings.BEE_API_URL || settings.SWARM_GATEWAY_URL || SWARM_GATEWAY }).read(root)
  }
  const store: DiaryStore = {
    put: async (bytes) => {
      const swarm = swarmStore()
      if (swarm) return swarm.put(bytes)
      return onChain ? quietly(async () => (await openZeroG()).put(bytes)) : local.put(bytes)
    },
    get: async (root) => {
      if (!onChain) return local.get(root)
      // Reading needs no wallet and no library: anyone can do this with a plain web request.
      const { fetchFromZeroG } = await import("@ceasenet/demo/zeroG")
      return fetchFromZeroG(root)
    },
  }

  const targets = (): DiaryTarget[] => {
    const mode = readSettings().DIARY_MODE as DiaryMode | undefined
    return [
      // Your own agents' calls can hold anything. Sealed, they are all kept, and only you can read them.
      { id: "main", name: config.agent.name, home: homeDir(), address: config.agent.address, mode: mode ?? (ownerPublicKey ? "sealed" : "hashes") },
      // These trade paper money on public prices, and being readable by anyone is the point of them.
      ...TEAM.flatMap((m) => {
        const address = memberView(m).address
        return address ? [{ id: m.id, name: m.name, home: memberHome(m.id), address, mode: "public" as DiaryMode }] : []
      }),
    ]
  }

  // ---- Storing ----

  const problems = new Map<string, string>()
  let walletProblem: string | undefined
  let wallet: { address: string; balance?: string; low: boolean } | undefined
  let flushing = false

  const checkWallet = async (): Promise<boolean> => {
    if (!onChain) return true
    try {
      const z = await openZeroG()
      const balance = await z.balance()
      const low = balance < LOW_ZERO_G
      wallet = { address: z.address, balance: (Number(balance) / 1e18).toFixed(4), low }
      walletProblem = low ? `The wallet ${z.address} needs 0G test tokens to store diaries. Nothing is lost in the meantime. Get some at ${ZERO_G_FAUCET}` : undefined
      return !low
    } catch (e) {
      walletProblem = `Cannot reach 0G right now: ${shortError(e)}. Nothing is lost in the meantime.`
      return false
    }
  }

  const due = (target: DiaryTarget, force: boolean): boolean => {
    if (!hasWaiting(target.home)) return false
    if (force) return true
    // What an agent did just before it closed is exactly what someone will want to see, so it does not wait.
    const phase = readAgentState(target.home)?.phase
    if (phase === "closed" || phase === "off") return true
    const last = readDiaryState(target.home).lastStoredAt ?? 0
    return Date.now() - last >= STORE_EVERY_MS
  }

  const flush = async (force = false): Promise<void> => {
    if (flushing) return
    flushing = true
    try {
      const list = targets().filter((t) => due(t, force))
      if (list.length === 0 || (!swarmStore() && !(await checkWallet()))) return
      const writer = ledger.writer(payerKey)
      for (const target of list) {
        try {
          await storeWaiting(target, store, (agent, part) => writer.diary({ agent, ...part }), ownerPublicKey)
          problems.delete(target.id)
        } catch (e) {
          problems.set(target.id, explainWriteError(e, writer.address).message)
        }
      }
    } finally {
      flushing = false
    }
  }

  // ---- Reports ----

  let reports: ReportView[] = []
  let reportProblem: string | undefined

  const ownAgents = (): OwnAgent[] => {
    const mine = new Map<string, LoadedFile>()
    for (const g of liveGuards()) mine.set(g.file.hash, g.file)
    const agents: OwnAgent[] = [{ name: config.agent.name, address: config.agent.address, files: [...identityOf(config), ...mine.values()] }]
    for (const m of TEAM) {
      const view = memberView(m)
      if (view.address) agents.push({ name: m.name, address: view.address, files: [...identityFiles(view.address, owner), teamFile(owner), ...(view.state?.tools ?? [])] })
    }
    return agents
  }

  const refreshReports = async (): Promise<void> => {
    try {
      const settings = readSettings()
      const { reports: found, votes } = await readReports(client, [settings.REPORT_VERIFIER || ADDRESSES.verifier])
      reports = reportsFor(found, votes, ownAgents(), Number(settings.REPORT_VOTES_NEEDED) || DEFAULT_VOTES_NEEDED, loadHandled())
      reportProblem = undefined
    } catch (e) {
      reportProblem = `Cannot read reports right now: ${shortError(e)}`
    }
  }

  // ---- Running ----

  const timers = [setInterval(() => void flush(), TICK_MS), setInterval(() => void refreshReports(), REPORTS_EVERY_MS)]
  void refreshReports()

  const cache = new Map<string, Uint8Array>()
  const readPart = async (root: string, row: DiaryRow): Promise<Uint8Array> => {
    // A stored part cannot change, or it would not have this name.
    const known = cache.get(root)
    if (known) return known
    const bytes = row.storage === SEALED_ON_SWARM ? await readFromSwarm(root) : await store.get(root)
    cache.set(root, bytes)
    return bytes
  }

  type Route = (body: Record<string, unknown>, match: RegExpMatchArray) => Promise<unknown> | unknown
  const routes: Record<string, Route> = {
    "GET /api/diary": async () => {
      const onSwarm = Boolean(swarmStore())
      if (onChain && !onSwarm && !wallet) await checkWallet()
      return {
        where: onSwarm ? "swarm" : onChain ? "0g" : "local",
        wallet: onSwarm ? undefined : wallet,
        problem: onSwarm ? undefined : walletProblem,
        faucet: ZERO_G_FAUCET,
        agents: targets().map((t) => {
          const state = readDiaryState(t.home)
          return {
            id: t.id,
            name: t.name,
            address: t.address,
            mode: t.mode,
            entries: state.seq,
            parts: state.parts.length,
            lastStoredAt: state.lastStoredAt,
            waiting: waitingCount(t.home),
            problem: problems.get(t.id),
          }
        }),
      }
    },
    "POST /api/diary/store": async () => {
      await flush(true)
      return { stored: true }
    },
    "GET /api/diary/([\\w-]+)": async (_b, m) => {
      const target = targets().find((t) => t.id === m[1])
      if (!target) throw new Error("There is no such agent.")
      const index = await ledger.diaries(target.address)
      const parts: DiaryPartView[] = await readBack(index, readPart, keys.owner)
      return { id: target.id, name: target.name, address: target.address, mode: target.mode, where: onChain ? "0g" : "local", totalParts: index.length, canOpenSealed: Boolean(keys.owner), parts }
    },
    "GET /api/reports": () => ({
      reports,
      problem: reportProblem,
      votesNeeded: Number(readSettings().REPORT_VOTES_NEEDED) || DEFAULT_VOTES_NEEDED,
      verifier: readSettings().REPORT_VERIFIER || ADDRESSES.verifier,
    }),
    "POST /api/reports/(0x[0-9a-fA-F]+)/recall": async (_b, m) => {
      const report = reports.find((r) => r.key === m[1])
      if (!report) throw new Error("That report is not about one of your agents.")
      const reason = recallReasonFor(report)
      const { entityKey } = await ctx.timed(() =>
        report.kind === "agent"
          ? stopAgent(ledger, config, report.about[0]!.address, reason)
          : stopTool(ledger, config, {
              ...(report.artifact.startsWith("0x") ? { hash: report.artifact } : {}),
              name: report.pkg ?? report.target,
              versions: report.versions ?? "*",
              reason,
              severity: "HIGH",
            }),
      )
      markHandled(report.key, "recalled", entityKey)
      await refreshReports()
      return { recall: entityKey }
    },
    "POST /api/reports/(0x[0-9a-fA-F]+)/dismiss": async (_b, m) => {
      if (!reports.some((r) => r.key === m[1])) throw new Error("That report is not about one of your agents.")
      markHandled(m[1] as Hex, "dismissed")
      await refreshReports()
      return { dismissed: true }
    },
  }

  return {
    routes,
    /** What every page needs to know: someone is waiting for this owner to decide. */
    waiting: () => reports.filter((r) => r.state === "waiting").map((r) => ({ key: r.key, target: r.target, reason: r.reason, votes: r.votes, simulated: r.simulated })),
    close: () => timers.forEach(clearInterval),
  }
}
