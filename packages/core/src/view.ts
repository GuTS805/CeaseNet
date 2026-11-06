import type { ArkivPublic } from "./arkiv"
import type { BoardAgent } from "./board"
import { ADDRESSES, DEMO_OWNERS, demoPolicy } from "./deployment"
import {
  readAcksByAgents,
  readAgents,
  readArtifacts,
  readEndorsements,
  readHeartbeat,
  readLatestLoadout,
  readLifts,
  readRecallsBy,
  readTrustPolicy,
} from "./reader"
import type { AckRow, ArtifactRow, EndorseRow, LiftRow, RecallRow } from "./types"

export interface PublicView {
  block: bigint
  agents: BoardAgent[]
  recalls: RecallRow[]
  acks: AckRow[]
  lifts: LiftRow[]
  endorsements: EndorseRow[]
  artifacts: ArtifactRow[]
}

/** Everything the public pages show. Read straight from Arkiv, with no server of ours in between. */
export async function readPublicView(client: ArkivPublic, owners: readonly string[] = DEMO_OWNERS): Promise<PublicView> {
  const defaults = demoPolicy()
  const passports = await readAgents(client, owners)
  const agents = await Promise.all(
    passports.map(async (agent) => {
      const [loadout, heartbeat, policy] = await Promise.all([
        readLatestLoadout(client, agent.agent),
        readHeartbeat(client, agent.agent),
        readTrustPolicy(client, agent.owner),
      ])
      return { agent, loadout, heartbeat, policy } satisfies BoardAgent
    }),
  )

  // Recalls from any key that any of these owners follows, plus the demo's defaults.
  const issuers = new Set<string>([...defaults.issuers, defaults.verifier].map((a) => a.toLowerCase()))
  for (const { policy } of agents) {
    for (const a of [...(policy?.issuers ?? []), ...(policy ? [policy.verifier] : [])]) issuers.add(a.toLowerCase())
  }
  const { rows: recalls, block } = await readRecallsBy(client, [...issuers])
  recalls.sort((a, b) => Number(b.createdAt - a.createdAt))

  const [acks, lifts, endorsements, artifacts] = await Promise.all([
    readAcksByAgents(
      client,
      passports.map((p) => p.agent),
    ),
    readLifts(
      client,
      recalls.map((r) => r.key),
    ),
    readEndorsements(
      client,
      recalls.filter((r) => r.level === "ADVISORY").map((r) => r.key),
      defaults.verifier,
    ),
    readArtifacts(client, [ADDRESSES.maker, ADDRESSES.publisher]),
  ])
  return { block, agents, recalls, acks, lifts, endorsements, artifacts }
}
