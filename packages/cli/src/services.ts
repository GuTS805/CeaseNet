import { ARKIV_EXPLORER, arkivPublicClient, type ArkivPublic, readWholeList } from "@ceasenet/core"
import { chooseThinking, claudeAvailable, type ModelTest, testModel } from "./fleet"
import type { Config } from "./home"
import type { Ledger } from "./ledger"
import { formatBalance } from "./ledger"
import { hasStopHook, inspectAll, knownClientFiles } from "./protect"
import { settingsPath } from "./settings"

/**
 * What the console says about each service. Every status comes from asking it just now, or from what is really set
 * on this machine. Secrets are reported as set or missing, and never read out.
 */
export type ServiceStatus = "working" | "ready" | "limited" | "not-set-up" | "unreachable"

export interface ServiceCard {
  id: string
  name: string
  status: ServiceStatus
  /** What it is for here. */
  purpose: string
  /** What was just found out. */
  found: string[]
  /** What is needed to go further. */
  todo?: string
  /** What in this program uses it today. */
  usedBy: string
  link?: string
}

const TIMEOUT_MS = 6_000
/** A real request costs a little of the allowance it is checking, so it is not repeated often. */
const MODEL_TEST_MS = 5 * 60_000
let modelTest: { at: number; name: string; result: ModelTest } | undefined

async function probe(url: string, init?: RequestInit): Promise<{ ok: boolean; ms: number; detail: string }> {
  const startedAt = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    return { ok: res.ok, ms: Date.now() - startedAt, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, ms: Date.now() - startedAt, detail: (e as Error).message.split("\n")[0] ?? "no answer" }
  }
}

const reached = (name: string, r: { ok: boolean; ms: number; detail: string }) => (r.ok ? `${name} answered in ${r.ms} ms` : `${name} did not answer properly (${r.detail})`)
const setOrMissing = (names: string[], env: NodeJS.ProcessEnv) => names.map((n) => `${n}: ${env[n] ? "set" : "missing"}`)

export async function readServices(_config: Config, env: NodeJS.ProcessEnv): Promise<ServiceCard[]> {
  const settingsFile = settingsPath()

  const claude = claudeAvailable()
  const thinking = chooseThinking(env)
  // Whether a key is accepted says nothing about whether it has anything left today, so the model itself is asked.
  const modelName = thinking?.kind === "api" ? thinking.model : undefined
  if (modelName && (!modelTest || modelTest.name !== modelName || Date.now() - modelTest.at > MODEL_TEST_MS)) {
    modelTest = { at: Date.now(), name: modelName, result: await testModel(env, modelName) }
  }
  const tested = modelName ? modelTest?.result : undefined

  const [worldDev, worldIdp, swarm, zeroGIndexer, zeroGRpc] = await Promise.all([
    probe("https://developer.world.org/"),
    probe(`${(env.WORLD_IDP_ISSUER || "https://auth.world.org").replace(/\/+$/, "")}/.well-known/openid-configuration`),
    probe(`${(env.SWARM_GATEWAY_URL || "https://api.gateway.ethswarm.org").replace(/\/+$/, "")}/readiness`),
    // A file that does not exist still gets an answer from a healthy indexer.
    probe(`https://indexer-storage-testnet-turbo.0g.ai/file?root=0x${"0".repeat(64)}`),
    probe("https://evmrpc-testnet.0g.ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }),
  ])

  const reports = inspectAll(knownClientFiles())
  const protectedCount = reports.flatMap((r) => r.servers).filter((s) => s.state === "protected").length
  const unprotected = reports.flatMap((r) => r.servers).filter((s) => s.state === "unprotected").map((s) => s.name)

  const worldConfigured = Boolean(env.WORLD_APP_ID && env.WORLD_RP_ID && env.WORLD_RP_SIGNING_KEY)
  const passConfigured = Boolean(env.WORLD_IDP_CLIENT_ID && env.WORLD_IDP_CLIENT_SECRET)
  const swarmConfigured = Boolean(env.BEE_API_URL && env.SWARM_POSTAGE_BATCH_ID)

  return [
    {
      id: "model",
      name: "AI model",
      status: !thinking ? "not-set-up" : thinking.kind === "claude" || tested?.ok ? "working" : tested?.limited ? "limited" : "unreachable",
      purpose: "What the three agents think with. A real model decides each step, and it can only act through gated MCP tools.",
      found:
        thinking?.kind === "api"
          ? [
              `Using ${thinking.model} on ${thinking.host}`,
              tested?.ok ? `It made a real tool call in ${tested.ms} ms` : (tested?.limited ?? tested?.problem ?? "Not tried yet"),
              `The agents share a limit of ${thinking.requestsPerMinute} requests a minute`,
              claude.ok ? "Claude Code is here too, as another choice" : "Claude Code is not installed",
            ]
          : thinking
            ? [`Using Claude Code, ${thinking.version ?? "installed"}, with the ${thinking.model} model`, "It spends your own Claude plan or key"]
            : [claude.problem ?? "Claude Code is not installed", "MODEL_API_KEY: missing"],
      todo: !thinking ? "Run: ceasenet import-settings <your .env>, or install Claude Code and log in" : tested && !tested.ok ? "Choose another model at the top of the Agents page" : undefined,
      usedBy: "The three agents",
    },
    {
      id: "gate",
      name: "MCP clients on this machine",
      status: protectedCount > 0 && unprotected.length === 0 ? "working" : "ready",
      purpose: "Your own agents' tools, with the gate in front of them.",
      found: [
        `${protectedCount} ${protectedCount === 1 ? "server" : "servers"} protected`,
        unprotected.length ? `Not protected: ${unprotected.join(", ")}` : "None left unprotected",
        `Claude Code's own tools: ${hasStopHook() ? "covered" : "not covered"}`,
      ],
      todo: unprotected.length || !hasStopHook() ? "Run: ceasenet protect" : undefined,
      usedBy: "Your own agents",
    },
    {
      id: "world-idkit",
      name: "World ID: confirmations",
      status: worldConfigured ? (worldDev.ok ? "ready" : "unreachable") : "not-set-up",
      purpose: "Proves each person confirming a warning is a different real human. Three confirmations make every call to that tool wait for a person.",
      found: [reached("World", worldDev), ...setOrMissing(["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY"], env)],
      todo: worldConfigured ? "Start it with npm run verifier, and name its key as verifier on your trust list" : `Create an app at developer.world.org, and put the three settings in ${settingsFile}`,
      usedBy: "The verifier app and the public site. Not yet the agents here",
      link: "https://developer.world.org",
    },
    {
      id: "world-pass",
      name: "World ID: Agent Pass",
      status: passConfigured ? (worldIdp.ok ? "ready" : "unreachable") : "not-set-up",
      purpose: "A real person approves a waiting call from the World ID app. Without it, you approve at this console.",
      found: [reached("World's sign-in service", worldIdp), ...setOrMissing(["WORLD_IDP_CLIENT_ID", "WORLD_IDP_CLIENT_SECRET"], env)],
      todo: passConfigured ? undefined : `Register a client at auth.world.org/portal, and put the two settings in ${settingsFile}. Personal Google accounts were refused when we tried`,
      usedBy: "Every guard, once it is set up. Not yet run against World itself",
      link: "https://auth.world.org/portal",
    },
    {
      id: "swarm",
      name: "Swarm",
      status: swarm.ok ? (swarmConfigured ? "ready" : "not-set-up") : "unreachable",
      purpose: "Keeps fixed tools and sealed evidence somewhere that survives the maker's site going away. Reading is free. Storing needs a postage batch.",
      found: [reached("The public gateway", swarm), ...setOrMissing(["BEE_API_URL", "SWARM_POSTAGE_BATCH_ID"], env)],
      todo: swarmConfigured ? undefined : `To store files, run a Bee node with a postage batch, and put both settings in ${settingsFile}`,
      usedBy: "The scripted demo. Not yet the ceasenet program",
      link: "https://docs.ethswarm.org",
    },
    {
      id: "zerog",
      name: "0G Storage",
      status: zeroGRpc.ok && zeroGIndexer.ok ? "ready" : "unreachable",
      purpose: "Holds each agent's tamper-evident diary, with its hash on Arkiv, so a changed copy fails the check. Reading is free. Storing needs 0G test tokens.",
      found: [reached("The network", zeroGRpc), reached("The storage indexer", zeroGIndexer)],
      todo: "Storing needs a wallet with 0G test tokens, which the scripted demo's treasury can hold",
      usedBy: "The scripted demo. Not yet the ceasenet program",
      link: "https://docs.0g.ai",
    },
  ]
}

// ---- Arkiv ----

export interface RecordRow {
  type: string
  key?: string
  creator: string
  block?: string
  summary: string
  link?: string
}

export interface WalletRow {
  role: string
  address: string
  balance?: string
  empty?: boolean
  link: string
}

export interface ArkivView {
  /** Where recalls are kept right now. */
  mode: Config["network"]
  chain: {
    name: string
    chainId: number
    rpc: string
    explorer: string
    reachable: boolean
    block?: string
    latencyMs?: number
    error?: string
    accessKey: boolean
  }
  /** Every record of ours on the public chain, whoever wrote it. */
  publicList?: { recalls: number; stops: number; warnings: number; agents: number; receipts: number; lifts: number; files: number }
  wallets: WalletRow[]
  /** Everything on record about each agent. */
  agents: {
    name: string
    address: string
    owner?: string
    registered: boolean
    fingerprint?: string
    tools: { name: string; version: string; hash: string }[]
    made: { kind: string; name: string; hash: string }[]
    status?: string
    diaryParts: number
    diaryEntries: number
    link: string
  }[]
  /** What this owner and their agents have on the list in use. */
  records: Record<string, RecordRow[]>
  /** What a gate here actually asks for. */
  gateQuery: { issuers: string[]; verifier: string; text: string }
  canGoPublic: boolean
  goPublicBlockedBy?: string
}

const RPC_URL = "https://rpc.rabdi.db-chain.testnet.arkiv.network/"
const CHAIN_ID = 7794095

export interface ArkivInputs {
  config: Config
  ledger: Ledger
  client: ArkivPublic
  agents: { name: string; address: string }[]
}

export const makeArkivClient = (config: Config): ArkivPublic => arkivPublicClient(config.accessKey)

const entityLink = (mode: string, key: string | undefined) => (mode === "arkiv" && key ? `${ARKIV_EXPLORER}/entity/${key}` : undefined)
const clip = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n)}…` : text)

export async function readArkiv({ config, ledger, client, agents }: ArkivInputs): Promise<ArkivView> {
  const owner = config.owner.address
  const mode = config.network

  const chain: ArkivView["chain"] = {
    name: "Arkiv Rabdi testnet",
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    explorer: ARKIV_EXPLORER,
    reachable: false,
    accessKey: Boolean(config.accessKey),
  }
  const startedAt = Date.now()
  try {
    chain.block = String(await client.getBlockNumber({ cacheTime: 0 }))
    chain.latencyMs = Date.now() - startedAt
    chain.reachable = true
  } catch (e) {
    chain.error = (e as Error).message.split("\n")[0]
  }

  let publicList: ArkivView["publicList"]
  if (chain.reachable) {
    try {
      const view = await readWholeList(client)
      publicList = {
        recalls: view.recalls.length,
        stops: view.recalls.filter((r) => r.level === "STOP").length,
        warnings: view.recalls.filter((r) => r.level === "ADVISORY").length,
        agents: view.agents.length,
        receipts: view.acks.length,
        lifts: view.lifts.length,
        files: view.artifacts.length,
      }
    } catch {
      // The chain answered, but this larger read did not. The rest of the page still stands.
    }
  }

  // Balances are real chain values whichever list is in use, since they decide whether going public is possible.
  const balanceOf = (address: string) => (chain.reachable ? client.getBalance({ address: address as `0x${string}` }).catch(() => undefined) : Promise.resolve(undefined))
  const walletsIn = [{ role: "Owner", address: owner }, { role: config.agent.name, address: config.agent.address }, ...agents.map((a) => ({ role: a.name, address: a.address }))]
  const balances = await Promise.all(walletsIn.map((w) => balanceOf(w.address)))
  const wallets: WalletRow[] = walletsIn.map((w, i) => ({
    ...w,
    balance: balances[i] === undefined ? undefined : formatBalance(balances[i]!),
    empty: balances[i] === 0n,
    link: `${ARKIV_EXPLORER}/address/${w.address}`,
  }))

  // What is on the list in use, for this owner and the agents that answer to them.
  const published = await ledger.publishedPolicy(owner)
  const issuers = [...new Set([owner, ...(published?.issuers ?? [])])]
  const { rows: recalls } = await ledger.recalls(issuers)
  const keys = recalls.map((r) => r.key)
  const [lifts, acks, passports] = await Promise.all([ledger.lifts(keys), ledger.acks(keys), ledger.agents(owner)])
  const allAgents = [{ name: config.agent.name, address: config.agent.address }, ...agents]
  const [loadouts, beats, diaries] = await Promise.all([
    Promise.all(allAgents.map(async (a) => ({ a, row: await ledger.loadout(a.address as `0x${string}`) }))),
    Promise.all(allAgents.map(async (a) => ({ a, row: await ledger.heartbeat(a.address as `0x${string}`) }))),
    Promise.all(allAgents.map(async (a) => ({ a, rows: await ledger.diaries(a.address as `0x${string}`) }))),
  ])

  const agentRecords = allAgents.map((a) => {
    const passport = passports.find((p) => p.agent.toLowerCase() === a.address.toLowerCase())
    const loadout = loadouts.find((l) => l.a.address === a.address)?.row
    const stored = diaries.find((d) => d.a.address === a.address)?.rows ?? []
    return {
      name: a.name,
      address: a.address,
      owner: passport?.owner,
      registered: Boolean(passport),
      fingerprint: loadout?.fingerprint,
      tools: (loadout?.files ?? []).filter((f) => f.kind === "tool").map((f) => ({ name: f.name, version: f.version, hash: f.hash })),
      made: (loadout?.files ?? []).filter((f) => f.kind === "model" || f.kind === "prompt").map((f) => ({ kind: f.kind, name: f.name, hash: f.hash })),
      status: beats.find((b) => b.a.address === a.address)?.row?.mode,
      diaryParts: stored.length,
      diaryEntries: stored.reduce((n, d) => n + Number(d.entries), 0),
      link: `${ARKIV_EXPLORER}/address/${a.address}`,
    }
  })

  const newestFirst = <T extends { block?: string }>(rows: T[]) => [...rows].sort((a, b) => Number(BigInt(b.block ?? "0") - BigInt(a.block ?? "0")))

  const records: ArkivView["records"] = {
    Recalls: newestFirst(
      recalls.map((r) => ({
        type: r.level === "STOP" ? "STOP" : "Warning",
        key: r.key,
        creator: r.creator,
        block: String(r.createdAt),
        summary: `${r.artifact.startsWith("agent:") || r.artifact.startsWith("fleet:") || r.artifact.startsWith("team:") ? `${r.artifact.split(":")[0]} stop` : (r.pkg ?? clip(r.artifact, 24))}: ${clip(r.reason)}`,
        link: entityLink(mode, r.key),
      })),
    ),
    Lifts: newestFirst(
      lifts.map((l) => ({ type: l.kind, key: l.key, creator: l.creator, block: String(l.createdAt), summary: clip(l.note ?? `Ends ${l.recall}`), link: entityLink(mode, l.key) })),
    ),
    Receipts: newestFirst(
      acks.map((a) => ({
        type: a.action,
        key: a.key,
        creator: a.creator,
        block: String(a.createdAt),
        summary: `${allAgents.find((x) => x.address.toLowerCase() === a.agent.toLowerCase())?.name ?? a.agent} obeyed a recall from ${a.issuer.slice(0, 10)}…`,
        link: entityLink(mode, a.key),
      })),
    ),
    Passports: passports.map((p) => ({ type: "Agent", key: p.key, creator: p.creator, summary: `${p.name}, answering to its owner ${p.owner.slice(0, 10)}…`, link: entityLink(mode, p.key) })),
    Loadouts: loadouts.flatMap(({ a, row }) =>
      row
        ? [
            {
              type: "Loadout",
              key: row.key,
              creator: row.creator,
              block: String(row.createdAt),
              summary: `${a.name}: ${row.files.filter((f) => f.kind === "tool").map((f) => `${f.name} ${f.version}`).join(", ") || "no tools"}${row.fingerprint ? `. Fingerprint ${row.fingerprint.slice(0, 12)}…` : ""}`,
              link: entityLink(mode, row.key),
            },
          ]
        : [],
    ),
    Diaries: diaries.flatMap(({ a, rows }) =>
      rows.map((d) => ({
        type: "Diary part",
        key: d.key,
        creator: d.creator,
        block: String(d.createdAt),
        summary: `${a.name}: entries ${d.firstSeq} to ${d.lastSeq}, stored at ${d.root.slice(0, 14)}…`,
        link: entityLink(mode, d.key),
      })),
    ),
    Heartbeats: beats.flatMap(({ a, row }) =>
      row ? [{ type: row.mode, key: row.key, creator: row.creator, block: String(row.updatedAt), summary: `${a.name} is alive and reporting`, link: entityLink(mode, row.key) }] : [],
    ),
    "Trust list": published
      ? [{ type: "Trust list", creator: owner, summary: `Obeys ${published.issuers.length} ${published.issuers.length === 1 ? "key" : "keys"}: ${published.issuers.map((i) => `${i.slice(0, 10)}…`).join(", ")}` }]
      : [],
  }

  const ownerWallet = wallets[0]!
  const activeLocal = mode === "local" && recalls.some((r) => !lifts.some((l) => l.recall === r.key && l.kind === "WITHDRAWN"))

  return {
    mode,
    chain,
    publicList,
    wallets,
    agents: agentRecords,
    records,
    gateQuery: {
      issuers,
      verifier: published?.verifier ?? owner,
      text: `ceasenet.recall where $creator is one of the keys above, read in full and matched on this machine`,
    },
    canGoPublic: mode === "local" && chain.reachable && ownerWallet.empty === false && !activeLocal,
    goPublicBlockedBy:
      mode !== "local"
        ? undefined
        : !chain.reachable
          ? "The chain cannot be reached right now."
          : ownerWallet.empty !== false
            ? "Your owner wallet needs funds first."
            : activeLocal
              ? "You have recalls in force on the local list, and they would not carry over. Lift them first."
              : undefined,
  }
}
