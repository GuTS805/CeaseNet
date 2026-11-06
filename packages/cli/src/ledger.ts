import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  type AckIntent,
  type AckRow,
  agentFingerprint,
  type AgentRow,
  type AgentStatus,
  arkivPublicClient,
  arkivWalletClient,
  ArkivWriter,
  decodeMemory,
  diaryInRange,
  type DiaryRow,
  encodeMemory,
  type GateView,
  hashBytes,
  type HeartbeatRow,
  identityOnly,
  type Hex,
  type LiftKind,
  type LiftRow,
  type LoadedFile,
  type LoadoutRow,
  readAcks,
  readAgents,
  readDiaryIndex,
  readGateView,
  readHeartbeat,
  readLatestLoadout,
  readLifts,
  readRecallsBy,
  readTrustPolicy,
  recallContentHash,
  type RecallInput,
  type RecallRow,
  type TimeRange,
  type TrustPolicy,
} from "@ceasenet/core"
import { ArkivGuardNet, type GuardNet, ReadOnlyNet, writeAtomic } from "@ceasenet/guard"
import { formatEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { type Config, inHome, obeyingOwner } from "./home"

export interface LiftInput {
  recall: Hex
  artifact: string
  kind: LiftKind
  fixedHash?: string
  fixedVersion?: string
  note?: string
}

/** Speaks for one key. */
export interface LedgerWriter {
  readonly address: Hex
  stop(input: RecallInput): Promise<{ entityKey: Hex }>
  lift(input: LiftInput): Promise<{ entityKey: Hex }>
  trustList(input: { seq: bigint; policy: TrustPolicy }): Promise<{ entityKey: Hex }>
  agent(input: { agent: Hex; name: string; framework: string; purpose: string }): Promise<{ entityKey: Hex }>
  /** One stored part of an agent's diary, written on its behalf. */
  diary(input: { agent: Hex; root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint; storage?: string; firstAt?: number; lastAt?: number }): Promise<{ entityKey: Hex }>
  send(to: Hex, amount: bigint): Promise<void>
}

/** Where recalls live. The public list on Arkiv, or a file for when one machine is all that matters. */
export interface Ledger {
  readonly kind: Config["network"]
  /** What a gate reads. The owner's own STOPs always count. */
  readOnlyNet(): GuardNet
  /** What this agent writes: what it has loaded, that it is alive, and its receipts. */
  agentNet(agentKey: Hex, heartbeatTtlSeconds: number): GuardNet
  writer(key: Hex): LedgerWriter
  publishedPolicy(owner: string): Promise<TrustPolicy | undefined>
  recalls(creators: readonly string[]): Promise<{ rows: RecallRow[]; block: bigint }>
  lifts(recalls: readonly Hex[]): Promise<LiftRow[]>
  acks(recalls: readonly Hex[]): Promise<AckRow[]>
  agents(owner: string): Promise<AgentRow[]>
  heartbeat(agent: Hex): Promise<HeartbeatRow | undefined>
  loadout(agent: Hex): Promise<LoadoutRow | undefined>
  /** Where an agent's diary is stored, from its own key or its owner's. Given a span of time, only the parts inside it. */
  diaries(agent: Hex, range?: TimeRange): Promise<DiaryRow[]>
  /** Undefined where there is no such thing as a balance. */
  balance(address: Hex): Promise<bigint | undefined>
}

export const formatBalance = (wei: bigint): string => Number(formatEther(wei)).toLocaleString("en", { maximumFractionDigits: 4 })

// ---- The public list ----

class ArkivReadNet extends ReadOnlyNet {
  constructor(
    private readonly clientFor: ReturnType<typeof arkivPublicClient>,
    private readonly ownerAddress: string,
  ) {
    super(clientFor, ownerAddress)
  }

  override readView(policy: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> {
    return readObeyingOwner(this.clientFor, this.ownerAddress, policy, remembered)
  }
}

export class ArkivAgentNet extends ArkivGuardNet {
  constructor(
    private readonly clientFor: ReturnType<typeof arkivPublicClient>,
    private readonly ownerAddress: string,
    writer: ArkivWriter,
    ttl: number,
    /** Set when the owner keeps what this agent runs private: it is kept here instead, and the list gets only who the agent is. */
    private readonly keepPrivate?: (seq: bigint, files: LoadedFile[]) => void,
  ) {
    super(clientFor, ownerAddress, writer, ttl)
  }

  override async writeLoadout(seq: bigint, files: LoadedFile[]): Promise<void> {
    if (!this.keepPrivate) return super.writeLoadout(seq, files)
    this.keepPrivate(seq, files)
    return super.writeLoadout(seq, identityOnly(files))
  }

  override readView(policy: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> {
    return readObeyingOwner(this.clientFor, this.ownerAddress, policy, remembered)
  }
}

async function readObeyingOwner(client: ReturnType<typeof arkivPublicClient>, owner: string, fallback: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> {
  // An agent obeys only its owner, whatever list anyone has published, so there is nothing more to read.
  const policy = obeyingOwner(fallback, owner)
  const view = await readGateView(client, undefined, policy, remembered)
  return { ...view, policy }
}

/**
 * What a private agent runs, kept on this machine only, next to the local list that every agent here shares. The
 * console reads it back, so its owner still sees everything while the public list sees only who the agent is.
 */
const privateLoadoutPath = (config: Config, agent: string): string =>
  join(dirname(config.ledgerFile ?? inHome("ledger.jsonl")), "private-loadouts", `${agent.toLowerCase()}.json`)

export function savePrivateLoadout(config: Config, agent: string, seq: bigint, files: LoadedFile[]): void {
  writeAtomic(privateLoadoutPath(config, agent), `${JSON.stringify({ seq: seq.toString(), files }, null, 2)}\n`)
}

/** Puts back what a private agent runs, from this machine, when the public record is the one it belongs to. */
export function withPrivateLoadout(config: Config, row: LoadoutRow | undefined): LoadoutRow | undefined {
  if (!row) return row
  const path = privateLoadoutPath(config, row.agent)
  if (!existsSync(path)) return row
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as { seq: string; files: LoadedFile[] }
    if (kept.seq !== row.seq.toString()) return row
    return { ...row, files: kept.files, fingerprint: agentFingerprint(kept.files) }
  } catch {
    return row
  }
}

export function arkivLedger(config: Config): Ledger {
  const client = arkivPublicClient(config.accessKey, config.rpc)
  const owner = config.owner.address
  const writerFor = (key: Hex) => new ArkivWriter(arkivWalletClient(privateKeyToAccount(key), config.accessKey, config.rpc))
  return {
    kind: "arkiv",
    readOnlyNet: () => new ArkivReadNet(client, owner),
    agentNet: (agentKey, ttl) => {
      const writer = writerFor(agentKey)
      const keepPrivate = config.privacy === "private" ? (seq: bigint, files: LoadedFile[]) => savePrivateLoadout(config, writer.address, seq, files) : undefined
      return new ArkivAgentNet(client, owner, writer, ttl, keepPrivate)
    },
    writer: (key) => {
      const writer = writerFor(key)
      return {
        address: writer.address,
        stop: (input) => writer.stop(input),
        lift: (input) => writer.lift(input),
        trustList: (input) => writer.trustList(input),
        agent: (input) => writer.agent(input),
        diary: (input) => writer.diary(input),
        send: async (to, value) => {
          const hash = await writer.wallet.sendTransaction({ to, value })
          await client.waitForTransactionReceipt({ hash })
        },
      }
    },
    publishedPolicy: (o) => readTrustPolicy(client, o),
    recalls: (creators) => readRecallsBy(client, creators),
    lifts: (recalls) => readLifts(client, recalls),
    acks: (recalls) => readAcks(client, recalls),
    agents: (o) => readAgents(client, [o]),
    heartbeat: (agent) => readHeartbeat(client, agent),
    loadout: async (agent) => withPrivateLoadout(config, await readLatestLoadout(client, agent)),
    diaries: (agent, range) => readDiaryIndex(client, agent, owner, range),
    balance: (address) => client.getBalance({ address }),
  }
}

// ---- This machine only ----

type Row =
  | ({ type: "recall" } & RecallRow)
  | ({ type: "lift" } & LiftRow)
  | ({ type: "ack" } & AckRow)
  | ({ type: "agent" } & AgentRow)
  | ({ type: "loadout" } & LoadoutRow)
  | ({ type: "trust"; creator: Hex; seq: string; policy: TrustPolicy })
  | ({ type: "beat"; expiresAtMs: number } & HeartbeatRow)
  | ({ type: "diary" } & DiaryRow)

/** Blocks on Arkiv arrive every 2 seconds, so local rows can be read the same way. */
const localBlock = (): bigint => BigInt(Math.floor(Date.now() / 2000))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const FAR_AHEAD = 7_000_000n

/**
 * The same records as the public list, in a file on this machine.
 *
 * Nothing here is public or signed, and only processes on this machine can see it. It exists so that stopping an
 * agent works from the first minute, with no wallet, and it is labelled as local everywhere it shows.
 */
export function localLedger(config: Config): Ledger {
  const path = config.ledgerFile ?? inHome("ledger.jsonl")
  const owner = config.owner.address

  const rows = (): Row[] => {
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeMemory(line) as unknown as Row)
  }
  const add = (row: Row): void => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${encodeMemory(row as never)}\n`)
  }
  const newKey = (seed: unknown): Hex => hashBytes(`${encodeMemory(seed as never)}:${Date.now()}:${Math.random()}`)
  const of = <T extends Row["type"]>(type: T) => rows().filter((r): r is Extract<Row, { type: T }> => r.type === type)

  const publishedPolicy = async (who: string): Promise<TrustPolicy | undefined> =>
    of("trust")
      .filter((t) => same(t.creator, who))
      .sort((a, b) => Number(BigInt(b.seq) - BigInt(a.seq)))[0]?.policy

  const readView = async (fallback: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> => {
    const policy = obeyingOwner((await publishedPolicy(owner)) ?? fallback, owner)
    const issuers = new Set([...policy.issuers, policy.verifier].map((a) => a.toLowerCase()))
    const recalls = of("recall").filter((r) => issuers.has(r.creator.toLowerCase()))
    const keys = new Set<string>([...recalls.map((r) => r.key), ...remembered])
    return {
      block: localBlock(),
      policy,
      stops: recalls.filter((r) => r.level === "STOP"),
      advisories: recalls.filter((r) => r.level === "ADVISORY"),
      endorsements: [],
      lifts: of("lift").filter((l) => keys.has(l.recall)),
    }
  }

  const readOnlyNet = (): GuardNet => ({
    readView,
    writeLoadout: async () => undefined,
    writeHeartbeat: async () => undefined,
    writeAck: async () => undefined,
    extendRecall: async () => undefined,
  })

  return {
    kind: "local",
    readOnlyNet,
    agentNet: (agentKey, ttl) => {
      const agent = privateKeyToAccount(agentKey).address
      return {
        readView,
        writeLoadout: async (seq: bigint, files: LoadedFile[]) => {
          add({ type: "loadout", key: newKey(files), agent, seq, files, fingerprint: agentFingerprint(files), creator: agent, createdAt: localBlock() })
        },
        writeHeartbeat: async (status: AgentStatus, seq: bigint) => {
          add({
            type: "beat",
            key: newKey(status),
            agent,
            mode: status,
            loadoutSeq: seq,
            creator: agent,
            updatedAt: localBlock(),
            expiresAt: FAR_AHEAD,
            expiresAtMs: Date.now() + ttl * 1000,
          })
        },
        writeAck: async (intent: AckIntent, newHash?: string) => {
          add({
            type: "ack",
            key: newKey(intent.recall.key),
            recall: intent.recall.key,
            recallHash: intent.recall.contentHash,
            agent,
            artifact: intent.recall.artifact,
            action: intent.action,
            issuer: intent.recall.creator,
            newHash,
            creator: agent,
            createdAt: localBlock(),
          })
        },
        extendRecall: async () => undefined,
      }
    },
    writer: (key) => {
      const address = privateKeyToAccount(key).address
      return {
        address,
        stop: async (input) => {
          const artifact = input.artifact.toLowerCase()
          const entityKey = newKey(input)
          add({
            type: "recall",
            key: entityKey,
            artifact,
            level: "STOP",
            severity: input.severity,
            reason: input.reason,
            contentHash: recallContentHash({ artifact, level: "STOP", severity: input.severity, reason: input.reason }),
            creator: address,
            createdAt: localBlock(),
            expiresAt: FAR_AHEAD,
            advice: input.advice,
            pkg: input.pkg,
            versions: input.versions,
          })
          return { entityKey }
        },
        lift: async (input) => {
          const entityKey = newKey(input)
          add({ type: "lift", key: entityKey, ...input, artifact: input.artifact.toLowerCase(), creator: address, createdAt: localBlock() })
          return { entityKey }
        },
        trustList: async ({ seq, policy }) => {
          add({ type: "trust", creator: address, seq: String(seq), policy })
          return { entityKey: newKey(policy) }
        },
        agent: async (input) => {
          const entityKey = newKey(input)
          add({ type: "agent", key: entityKey, ...input, owner: address, creator: address })
          return { entityKey }
        },
        diary: async (input) => {
          const entityKey = newKey(input)
          add({ type: "diary", key: entityKey, ...input, creator: address, createdAt: localBlock() })
          return { entityKey }
        },
        send: async () => undefined,
      }
    },
    publishedPolicy,
    recalls: async (creators) => {
      const wanted = new Set(creators.map((c) => c.toLowerCase()))
      return { rows: of("recall").filter((r) => wanted.has(r.creator.toLowerCase())), block: localBlock() }
    },
    lifts: async (recalls) => of("lift").filter((l) => recalls.includes(l.recall)),
    acks: async (recalls) => of("ack").filter((a) => recalls.includes(a.recall)),
    agents: async (who) => of("agent").filter((a) => same(a.creator, who) && same(a.owner, who)),
    heartbeat: async (agent) => {
      const beats = of("beat").filter((b) => same(b.creator, agent) && b.expiresAtMs > Date.now())
      return beats[beats.length - 1]
    },
    loadout: async (agent) => {
      const all = of("loadout").filter((l) => same(l.creator, agent))
      return all[all.length - 1]
    },
    diaries: async (agent, range) =>
      of("diary")
        .filter((d) => same(d.agent, agent) && (same(d.creator, agent) || same(d.creator, owner)) && diaryInRange(d, range))
        .sort((a, b) => Number(b.lastSeq - a.lastSeq)),
    balance: async () => undefined,
  }
}

export const ledgerFor = (config: Config): Ledger => (config.network === "local" ? localLedger(config) : arkivLedger(config))
