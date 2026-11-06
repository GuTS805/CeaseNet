import { asc, eq, gt, or } from "@arkiv-network/sdk/query"
import { addr, key } from "@arkiv-network/sdk/schema"
import { hexToString } from "viem"
import type { ArkivPublic } from "./arkiv"
import type { BoardRobot } from "./board"
import { ADDRESSES, fleetTrust } from "./deployment"
import {
  readEndorsements,
  readHeartbeat,
  readLatestLoadout,
  readLifts,
  readRecallsBy,
  readRobots,
} from "./reader"
import { Ack, Artifact, Custody, Disclose, Episode } from "./schema"
import type { AckRow, EndorseRow, Hex, LiftRow, RecallRow } from "./types"

/** Receipts created by these robots' own keys. */
export async function readAcksByRobots(client: ArkivPublic, robots: readonly Hex[]): Promise<AckRow[]> {
  if (robots.length === 0) return []
  const rows: AckRow[] = []
  let after: Hex | undefined
  for (;;) {
    const page: any = await client
      .select()
      .from(Ack)
      .where(or(robots.map((r) => eq("$creator", addr(r)))), ...(after ? [gt("$key", key(after))] : []))
      .orderBy(asc("$key"))
      .limit(100)
      .fetch()
    for (const r of page.entities) {
      rows.push({
        key: r.$key,
        recall: r.recall.value,
        recallHash: r.recallHash.value,
        robot: r.robot.value,
        artifact: r.artifact.value,
        action: r.action.value,
        issuer: r.issuer.value,
        newHash: r.newHash?.value,
        creator: r.$creator,
        createdAt: r.$createdAt,
      })
    }
    if (page.entities.length + page.skipped < 100 || page.entities.length === 0) break
    after = page.entities[page.entities.length - 1].$key
  }
  return rows
}

export interface ArtifactRow {
  hash: string
  kind: string
  name: string
  version: string
  creator: Hex
  source?: string
}

/** What is known about these files, from publishers the reader trusts. */
export async function readArtifacts(
  client: ArkivPublic,
  hashes: readonly string[],
  publishers: readonly string[],
): Promise<ArtifactRow[]> {
  if (hashes.length === 0) return []
  const res: any = await client
    .select()
    .from(Artifact)
    .where(or(hashes.map((h) => eq("hash", h.toLowerCase()))), or(publishers.map((p) => eq("$creator", addr(p)))))
    .limit(100)
    .fetch()
  return res.entities.map((r: any) => ({
    hash: r.hash.value,
    kind: r.kind.value,
    name: r.name.value,
    version: r.version.value,
    creator: r.$creator,
    source: r.source?.value,
  }))
}

export interface CustodyRow {
  operator: string
  contact: string
  owner: Hex
  creator: Hex
}

/** Who is responsible for a robot. Only a record its maker created counts, whoever holds it now. */
export async function readCustody(client: ArkivPublic, robot: Hex, maker: Hex): Promise<CustodyRow | undefined> {
  const res: any = await client
    .select()
    .from(Custody)
    .where(eq("robot", addr(robot)), eq("$creator", addr(maker)))
    .limit(20)
    .fetch()
  const r = [...res.entities].sort((a: any, b: any) => Number(b.$createdAt - a.$createdAt))[0]
  if (!r) return undefined
  return { operator: r.operator.value, contact: r.contact.value, owner: r.$owner, creator: r.$creator }
}

export interface EpisodeRow {
  key: Hex
  robot: Hex
  softwareHash: string
  root: string
  decisions: bigint
  firstRequestId: string
  lastRequestId: string
  createdAt: bigint
}

/** Decision-log index entries. Only the robot's own key can have created them. */
export async function readEpisodes(client: ArkivPublic, robot: Hex): Promise<EpisodeRow[]> {
  const res: any = await client.select().from(Episode).where(eq("$creator", addr(robot))).limit(100).fetch()
  return res.entities
    .map((r: any) => ({
      key: r.$key,
      robot: r.robot.value,
      softwareHash: r.softwareHash.value,
      root: r.root.value,
      decisions: BigInt(r.decisions.value),
      firstRequestId: r.firstRequestId.value,
      lastRequestId: r.lastRequestId.value,
      createdAt: r.$createdAt,
    }))
    .sort((a: EpisodeRow, b: EpisodeRow) => Number(b.createdAt - a.createdAt))
}

export interface DisclosureRow {
  recall: Hex
  description: string
  reproductionRef?: string
  creator: Hex
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
  }))
}

export interface FleetView {
  block: bigint
  robots: BoardRobot[]
  recalls: RecallRow[]
  acks: AckRow[]
  lifts: LiftRow[]
  endorsements: EndorseRow[]
}

/** Everything the public pages show. Read straight from Arkiv, with no server of ours in between. */
export async function readFleetView(client: ArkivPublic): Promise<FleetView> {
  const trust = fleetTrust()
  const passports = await readRobots(client, [ADDRESSES.maker])
  const robots = await Promise.all(
    passports.map(async (robot) => {
      const [loadout, heartbeat] = await Promise.all([
        readLatestLoadout(client, robot.robot),
        readHeartbeat(client, robot.robot),
      ])
      return { robot, loadout, heartbeat } satisfies BoardRobot
    }),
  )
  const { rows: recalls, block } = await readRecallsBy(client, [...trust.stopKeys, trust.verifier])
  recalls.sort((a, b) => Number(b.createdAt - a.createdAt))
  const [acks, lifts, endorsements] = await Promise.all([
    readAcksByRobots(
      client,
      passports.map((p) => p.robot),
    ),
    readLifts(
      client,
      recalls.map((r) => r.key),
    ),
    readEndorsements(
      client,
      recalls.filter((r) => r.level === "ADVISORY").map((r) => r.key),
      trust.verifier,
    ),
  ])
  return { block, robots, recalls, acks, lifts, endorsements }
}
