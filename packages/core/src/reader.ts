import { asc, desc, eq, gt, or } from "@arkiv-network/sdk/query"
import { addr, key } from "@arkiv-network/sdk/schema"
import type { ArkivPublic } from "./arkiv"
import type { TrustConfig } from "./gate"
import { Ack, Endorse, Heartbeat, Lift, Loadout, Recall, Robot } from "./schema"
import type {
  AckAction,
  AckRow,
  EndorseRow,
  HeartbeatRow,
  Hex,
  LiftKind,
  LiftRow,
  LoadedFile,
  LoadoutRow,
  Mode,
  RecallLevel,
  RecallRow,
  RobotRow,
  Stance,
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

function toRecall(r: any): RecallRow {
  return {
    key: r.$key,
    artifact: r.artifact.value,
    level: r.level.value as RecallLevel,
    severity: r.severity.value,
    reason: r.reason.value,
    contentHash: r.contentHash.value,
    creator: r.$creator,
    createdAt: r.$createdAt,
    expiresAt: r.$expiresAt,
    advice: opt(r.advice),
    sealedEvidence: opt(r.sealedEvidence),
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
    fixedRef: opt(r.fixedRef),
    note: opt(r.note),
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

function toAck(r: any): AckRow {
  return {
    key: r.$key,
    recall: r.recall.value,
    recallHash: r.recallHash.value,
    robot: r.robot.value,
    artifact: r.artifact.value,
    action: r.action.value as AckAction,
    issuer: r.issuer.value,
    newHash: opt(r.newHash),
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

/** Recalls on any of these files, from any of these creators. */
export async function readRecalls(client: ArkivPublic, hashes: readonly string[], creators: readonly string[]) {
  if (hashes.length === 0 || creators.length === 0) return { rows: [] as RecallRow[], block: 0n }
  const res = await readAll((after) =>
    client
      .select()
      .from(Recall)
      .where(or(hashes.map((h) => eq("artifact", h))), or(creators.map((c) => eq("$creator", addr(c)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return { rows: res.rows.map(toRecall), block: res.block }
}

/** Every recall created by these keys. Used by the public pages. */
export async function readRecallsBy(client: ArkivPublic, creators: readonly string[]) {
  if (creators.length === 0) return { rows: [] as RecallRow[], block: 0n }
  const res = await readAll((after) =>
    client
      .select()
      .from(Recall)
      .where(or(creators.map((c) => eq("$creator", addr(c)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return { rows: res.rows.map(toRecall), block: res.block }
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

/** Registered robots: passports created by a maker this reader trusts. */
export async function readRobots(client: ArkivPublic, makers: readonly string[]): Promise<RobotRow[]> {
  if (makers.length === 0) return []
  const res = await readAll<any>((after) =>
    client
      .select()
      .from(Robot)
      .where(or(makers.map((m) => eq("$creator", addr(m)))), ...afterKey(after))
      .orderBy(asc("$key"))
      .limit(PAGE)
      .fetch() as any,
  )
  return res.rows.map((r) => ({
    key: r.$key,
    robot: r.robot.value,
    maker: r.maker.value,
    model: r.model.value,
    serial: r.serial.value,
    city: r.city.value,
    creator: r.$creator,
  }))
}

/** A robot's newest loadout. Only its own key can have created it. */
export async function readLatestLoadout(client: ArkivPublic, robot: Hex): Promise<LoadoutRow | undefined> {
  const res = await client.select().from(Loadout).where(eq("$creator", addr(robot))).orderBy(desc("seq")).limit(1).fetch()
  const r = res.entities[0] as any
  if (!r) return undefined
  return {
    key: r.$key,
    robot: r.robot.value,
    seq: BigInt(r.seq.value),
    files: JSON.parse(r.files.value) as LoadedFile[],
    creator: r.$creator,
    createdAt: r.$createdAt,
  }
}

/** A robot's heartbeat. No result means nobody can vouch for the robot right now. */
export async function readHeartbeat(client: ArkivPublic, robot: Hex): Promise<HeartbeatRow | undefined> {
  const res = await client.select().from(Heartbeat).where(eq("$creator", addr(robot))).limit(1).fetch()
  const r = res.entities[0] as any
  if (!r) return undefined
  return {
    key: r.$key,
    robot: r.robot.value,
    mode: r.mode.value as Mode,
    loadoutSeq: BigInt(r.loadoutSeq.value),
    creator: r.$creator,
    updatedAt: r.$updatedAt,
    expiresAt: r.$expiresAt,
  }
}

export interface GateView {
  block: bigint
  stops: RecallRow[]
  advisories: RecallRow[]
  endorsements: EndorseRow[]
  lifts: LiftRow[]
}

/**
 * Everything a safety gate needs for one check.
 *
 * `extraRecalls` are STOPs the gate already remembers: their lifts must keep being read even when the
 * STOP itself has vanished from Arkiv or the robot has moved on from that file.
 */
export async function readGateView(
  client: ArkivPublic,
  hashes: readonly string[],
  trust: TrustConfig,
  extraRecalls: readonly Hex[] = [],
): Promise<GateView> {
  const creators = [...trust.stopKeys, trust.verifier]
  const { rows, block } = await readRecalls(client, hashes, creators)
  const stops = rows.filter((r) => r.level === "STOP")
  const advisories = rows.filter((r) => r.level === "ADVISORY")
  const [endorsements, lifts] = await Promise.all([
    readEndorsements(
      client,
      advisories.map((a) => a.key),
      trust.verifier,
    ),
    readLifts(client, [...new Set([...rows.map((r) => r.key), ...extraRecalls])]),
  ])
  return { block, stops, advisories, endorsements, lifts }
}
