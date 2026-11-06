import type { ArkivPublic } from "./arkiv"
import type { BoardAgent } from "./board"
import { ADDRESSES, DEMO_OWNERS, demoPolicy } from "./deployment"
import {
  type DisclosureRow,
  readAcksByAgents,
  readAgents,
  readArtifacts,
  readDisclosures,
  readEndorsements,
  readEveryAgent,
  readEveryRecall,
  readHeartbeat,
  readLatestLoadout,
  readLifts,
  readRecallsBy,
  readTrustPolicy,
} from "./reader"
import type { AckRow, AgentRow, ArtifactRow, EndorseRow, LiftRow, RecallRow } from "./types"

export interface PublicView {
  block: bigint
  agents: BoardAgent[]
  recalls: RecallRow[]
  acks: AckRow[]
  lifts: LiftRow[]
  endorsements: EndorseRow[]
  artifacts: ArtifactRow[]
  /** Public descriptions of recalls, only from the key that issued the recall or a regulator. */
  disclosures: DisclosureRow[]
}

const describeAgents = (client: ArkivPublic, passports: readonly AgentRow[]) =>
  Promise.all(
    passports.map(async (agent) => {
      const [loadout, heartbeat, policy] = await Promise.all([
        readLatestLoadout(client, agent.agent),
        readHeartbeat(client, agent.agent),
        readTrustPolicy(client, agent.owner),
      ])
      return { agent, loadout, heartbeat, policy } satisfies BoardAgent
    }),
  )

/** The demo's three companies and the keys they follow. The live demo screen reads this. */
export async function readPublicView(client: ArkivPublic, owners: readonly string[] = DEMO_OWNERS): Promise<PublicView> {
  const defaults = demoPolicy()
  const passports = await readAgents(client, owners)
  const agents = await describeAgents(client, passports)

  // Recalls from any key that any of these owners follows, plus the demo's defaults.
  const issuers = new Set<string>([...defaults.issuers, defaults.verifier].map((a) => a.toLowerCase()))
  for (const { policy } of agents) {
    for (const a of [...(policy?.issuers ?? []), ...(policy ? [policy.verifier] : [])]) issuers.add(a.toLowerCase())
  }
  const { rows: recalls, block } = await readRecallsBy(client, [...issuers])
  recalls.sort((a, b) => Number(b.createdAt - a.createdAt))

  return finishView(client, agents, recalls, block)
}

/**
 * The whole network: every passport and every recall on Arkiv, from anyone, with no list of keys to start from.
 * This is what a stranger sees, including their own agent and their own recall.
 */
export async function readNetworkView(client: ArkivPublic): Promise<PublicView> {
  const [passports, { rows: recalls, block }] = await Promise.all([readEveryAgent(client), readEveryRecall(client)])
  recalls.sort((a, b) => Number(b.createdAt - a.createdAt))
  return finishView(client, await describeAgents(client, passports), recalls, block)
}

async function finishView(client: ArkivPublic, agents: BoardAgent[], recalls: RecallRow[], block: bigint): Promise<PublicView> {
  const defaults = demoPolicy()
  const advisories = recalls.filter((r) => r.level === "ADVISORY").map((r) => r.key)
  const verifiers = new Set([defaults.verifier.toLowerCase(), ...agents.flatMap((a) => (a.policy ? [a.policy.verifier.toLowerCase()] : []))])
  const [acks, lifts, endorsements, artifacts, disclosures] = await Promise.all([
    readAcksByAgents(
      client,
      agents.map((a) => a.agent.agent),
    ),
    readLifts(
      client,
      recalls.map((r) => r.key),
    ),
    Promise.all([...verifiers].map((v) => readEndorsements(client, advisories, v))).then((all) => all.flat()),
    readArtifacts(client, [...new Set([ADDRESSES.maker, ADDRESSES.publisher, ...recalls.map((r) => r.creator)])]),
    readDisclosures(
      client,
      recalls.map((r) => r.key),
    ),
  ])
  const fromIssuer = (d: DisclosureRow) => {
    const recall = recalls.find((r) => r.key === d.recall)
    const by = d.creator.toLowerCase()
    return recall !== undefined && (by === recall.creator.toLowerCase() || by === ADDRESSES.regulator.toLowerCase())
  }
  return { block, agents, recalls, acks, lifts, endorsements, artifacts, disclosures: disclosures.filter(fromIssuer) }
}
