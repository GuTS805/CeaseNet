import { asc, desc, eq, gt, or } from "@arkiv-network/sdk/query"
import { addr, key } from "@arkiv-network/sdk/schema"
import { hexToString } from "viem"
import type { ArkivPublic } from "./arkiv"
import { Ack, Agent, Artifact, Diary, Disclose, Endorse, Heartbeat, Lift, Loadout, Recall, TrustList } from "./schema"
import type {
  AckAction,
  AckRow,
  AgentRow,
  AgentStatus,
  ArtifactRow,
  DiaryRow,
  EndorseRow,
  HeartbeatRow,
  Hex,
  LiftKind,
  LiftRow,
  LoadedFile,
  LoadoutRow,
  RecallLevel,
  RecallRow,
  Stance,
  TrustPolicy,
} from "./types"

const PAGE = 100

/** Reads every match, paging by key so nothing repeats or goes missing while others write. */
async function readAll<R extends { $key: Hex }>(
  page: (after: Hex | undefined) => Promise<{ entities: readonly R[]; blockNumber: bigint; skipped: number }>,
): Promise<{ rows: R[]; block: bigint }> {
  const rows: R[] = []
  let after: Hex | undefined
  let block = 0n
  for (;;) {
    const res = await page(after)
    block = res.blockNumber
    rows.push(...res.entities)
    if (res.entities.length === 0 || res.entities.length + res.skipped < PAGE) break
    after = res.entities[res.entities.length - 1]!.$key
  }
  return { rows, block }
}

const afterKey = (after: Hex | undefined) => (after ? [gt("$key", key(after))] : [])

type Text = { value: string } | undefined
const opt = (c: Text) => c?.value
const utf8 = (c: { value: string }) => hexToString(c.value as Hex)
const optUtf8 = (c: Text) => (c ? utf8(c) : undefined)

export function toRecallRow(r: any): RecallRow {
  return {
    key: r.$key,
    artifact: r.artifact.value,
    level: r.level.value as RecallLevel,
    severity: r.severity.value,
    reason: utf8(r.reason),
    contentHash: r.contentHash.value,
    creator: r.$creator,
    createdAt: r.$createdAt,
    expiresAt: r.$expiresAt,
    advice: optUtf8(r.advice),
    sealedEvidence: optUtf8(r.sealedEvidence),
    pkg: opt(r.pkg),
    versions: opt(r.versions),
  }
}

function toEndorse(r: any): EndorseRow {
  return {
    key: r.$key,
    recall: r.recall.value,
    stance: r.stance.value as Stance,
    human: r.human.value,
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

function toLift(r: any): LiftRow {
  return {
    key: r.$key,
    recall: r.recall.value,
    artifact: r.artifact.value,
    kind: r.kind.value as LiftKind,
    fixedHash: opt(r.fixedHash),
    fixedVersion: opt(r.fixedVersion),
    fixedRef: opt(r.fixedRef),
    note: optUtf8(r.note),
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

function toAck(r: any): AckRow {
  return {
    key: r.$key,
    recall: r.recall.value,
    recallHash: r.recallHash.value,
    agent: r.agent.value,
    artifact: r.artifact.value,
    action: r.action.value as AckAction,
    issuer: r.issuer.value,
    newHash: opt(r.newHash),
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

/** Every recall created by these keys. A gate reads all of them and matches locally, so the network never learns what it runs. */
export async function readRecallsBy(client: ArkivPublic, creators: readonly string[]) {
  if (creators.length === 0) return { rows: [] as RecallRow[], block: await client.getBlockNumber({ cacheTime: 0 }) }
  const res = await readAll((after) =>
    client
      .select()
      .from(Recall)
      .where(or(creators.map((c) => eq("$creator", addr(c)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return { rows: res.rows.map(toRecallRow), block: res.block }
}

export async function readEndorsements(client: ArkivPublic, recalls: readonly Hex[], verifier: string) {
  if (recalls.length === 0) return [] as EndorseRow[]
  const res = await readAll((after) =>
    client
      .select()
      .from(Endorse)
      .where(or(recalls.map((r) => eq("recall", key(r)))), eq("$creator", addr(verifier)), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toEndorse)
}

export async function readLifts(client: ArkivPublic, recalls: readonly Hex[]) {
  if (recalls.length === 0) return [] as LiftRow[]
  const res = await readAll((after) =>
    client
      .select()
      .from(Lift)
      .where(or(recalls.map((r) => eq("recall", key(r)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toLift)
}

/** Receipts for these recalls. Callers must still check each receipt's creator. */
export async function readAcks(client: ArkivPublic, recalls: readonly Hex[]) {
  if (recalls.length === 0) return [] as AckRow[]
  const res = await readAll((after) =>
    client
      .select()
      .from(Ack)
      .where(or(recalls.map((r) => eq("recall", key(r)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toAck)
}

/** Receipts created by these agents' own keys. */
export async function readAcksByAgents(client: ArkivPublic, agents: readonly Hex[]) {
  if (agents.length === 0) return [] as AckRow[]
  const res = await readAll((after) =>
    client
      .select()
      .from(Ack)
      .where(or(agents.map((a) => eq("$creator", addr(a)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toAck)
}

function toAgent(r: any): AgentRow {
  return {
    key: r.$key,
    agent: r.agent.value,
    owner: r.owner.value,
    name: r.name.value,
    framework: r.framework.value,
    purpose: utf8(r.purpose),
    creator: r.$creator,
  }
}

/** Passports created by these owners. Anyone can write a passport, so only the creator's key means anything. */
export async function readAgents(client: ArkivPublic, owners: readonly string[]): Promise<AgentRow[]> {
  if (owners.length === 0) return []
  const res = await readAll<any>((after) =>
    client
      .select()
      .from(Agent)
      .where(or(owners.map((o) => eq("$creator", addr(o)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toAgent).filter((a) => a.owner.toLowerCase() === a.creator.toLowerCase())
}

/** Every recall on Arkiv, from anyone. Showing one says nothing about whether anyone obeys it. */
export async function readEveryRecall(client: ArkivPublic) {
  const res = await readAll((after) =>
    client
      .select()
      .from(Recall)
      .where(...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return { rows: res.rows.map(toRecallRow), block: res.block }
}

/** Every passport on Arkiv. Only one created by the owner it names counts. */
export async function readEveryAgent(client: ArkivPublic): Promise<AgentRow[]> {
  const res = await readAll<any>((after) =>
    client
      .select()
      .from(Agent)
      .where(...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map(toAgent).filter((a) => a.owner.toLowerCase() === a.creator.toLowerCase())
}

/** The passport of one agent, whoever owns it. A passport only counts if the owner it names created it. */
export async function readAgent(client: ArkivPublic, agent: Hex): Promise<AgentRow | undefined> {
  const res: any = await client.select().from(Agent).where(eq("agent", addr(agent))).limit(50).fetch()
  return res.entities.map(toAgent).find((a: AgentRow) => a.owner.toLowerCase() === a.creator.toLowerCase())
}

/** An agent's newest loadout. Only its own key can have created it. */
export async function readLatestLoadout(client: ArkivPublic, agent: Hex): Promise<LoadoutRow | undefined> {
  const res = await client.select().from(Loadout).where(eq("$creator", addr(agent))).orderBy(desc("seq")).limit(1).fetch()
  const r = res.entities[0] as any
  if (!r) return undefined
  return {
    key: r.$key,
    agent: r.agent.value,
    seq: BigInt(r.seq.value),
    files: JSON.parse(utf8(r.files)) as LoadedFile[],
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

/** An agent's heartbeat. No result means nobody can vouch for the agent right now. */
export async function readHeartbeat(client: ArkivPublic, agent: Hex): Promise<HeartbeatRow | undefined> {
  const res = await client.select().from(Heartbeat).where(eq("$creator", addr(agent))).limit(20).fetch()
  // One is normal, but the newest is the one that counts if an old one has not expired yet.
  const r = [...(res.entities as any[])].sort((a, b) => Number(b.$updatedAt - a.$updatedAt))[0]
  if (!r) return undefined
  return {
    key: r.$key,
    agent: r.agent.value,
    mode: r.mode.value as AgentStatus,
    loadoutSeq: BigInt(r.loadoutSeq.value),
    creator: r.$creator,
    updatedAt: r.$updatedAt,
    expiresAt: r.$expiresAt,
  }
}

/** An owner's newest trust list. Only the owner's own key can have created it. */
export async function readTrustPolicy(client: ArkivPublic, owner: string): Promise<TrustPolicy | undefined> {
  const res: any = await client.select().from(TrustList).where(eq("$creator", addr(owner))).orderBy(desc("seq")).limit(1).fetch()
  const r = res.entities[0]
  return r ? (JSON.parse(utf8(r.policy)) as TrustPolicy) : undefined
}

/** What is known about these files, from publishers the reader trusts. */
export async function readArtifacts(client: ArkivPublic, publishers: readonly string[]): Promise<ArtifactRow[]> {
  if (publishers.length === 0) return []
  const res = await readAll<any>((after) =>
    client
      .select()
      .from(Artifact)
      .where(or(publishers.map((p) => eq("$creator", addr(p)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map((r) => ({
    key: r.$key,
    hash: r.hash.value,
    kind: r.kind.value,
    name: r.name.value,
    version: r.version.value,
    creator: r.$creator,
    source: r.source?.value,
  }))
}

/** Index of an agent's diary, newest first. Only its own key can have created these. */
export async function readDiaries(client: ArkivPublic, agent: Hex): Promise<DiaryRow[]> {
  const res = await readAll<any>((after) =>
    client
      .select()
      .from(Diary)
      .where(eq("$creator", addr(agent)), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows
    .map((r) => ({
      key: r.$key,
      agent: r.agent.value,
      root: r.root.value,
      head: r.head.value,
      entries: BigInt(r.entries.value),
      firstSeq: BigInt(r.firstSeq.value),
      lastSeq: BigInt(r.lastSeq.value),
      creator: r.$creator,
      createdAt: r.$createdAt,
    }))
    .sort((a, b) => Number(b.lastSeq - a.lastSeq))
}

export interface DisclosureRow {
  key: Hex
  recall: Hex
  description: string
  reproductionRef?: string
  creator: Hex
  createdAt: bigint
}

export async function readDisclosures(client: ArkivPublic, recalls: readonly Hex[]): Promise<DisclosureRow[]> {
  if (recalls.length === 0) return []
  const res: any = await client
    .select()
    .from(Disclose)
    .where(or(recalls.map((r) => eq("recall", key(r)))))
    .limit(100)
    .fetch()
  return res.entities.map((r: any) => ({
    recall: r.recall.value,
    description: hexToString(r.description.value),
    reproductionRef: r.reproductionRef?.value,
    creator: r.$creator,
    key: r.$key,
    createdAt: r.$createdAt,
  }))
}

export interface GateView {
  block: bigint
  /** The owner's newest trust list, if they have published one. */
  policy?: TrustPolicy
  stops: RecallRow[]
  advisories: RecallRow[]
  endorsements: EndorseRow[]
  lifts: LiftRow[]
}

/**
 * Everything a gate needs for one check.
 *
 * It reads every recall from the keys the owner follows and leaves the matching to the gate, so whoever runs
 * the RPC learns which keys this owner follows but not which tools the agent uses.
 *
 * `remembered` are STOPs the gate already knows: their lifts must keep being read even when the STOP itself
 * has vanished from Arkiv or the agent has moved on from that file.
 */
export async function readGateView(
  client: ArkivPublic,
  owner: string | undefined,
  fallback: TrustPolicy,
  remembered: readonly Hex[] = [],
): Promise<GateView> {
  const published = owner ? await readTrustPolicy(client, owner) : undefined
  const policy = published ?? fallback
  const { rows, block } = await readRecallsBy(client, [...new Set([...policy.issuers, policy.verifier])])
  const stops = rows.filter((r) => r.level === "STOP")
  const advisories = rows.filter((r) => r.level === "ADVISORY")
  const [endorsements, lifts] = await Promise.all([
    readEndorsements(
      client,
      advisories.map((a) => a.key),
      policy.verifier,
    ),
    readLifts(client, [...new Set([...rows.map((r) => r.key), ...remembered])]),
  ])
  return { block, policy: published, stops, advisories, endorsements, lifts }
}
