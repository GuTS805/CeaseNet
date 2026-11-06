import type { ArkivPublic } from "./arkiv"
import type { BoardAgent } from "./board"
import { ADDRESSES, DEMO_OWNERS, demoPolicy } from "./deployment"
import {
  type DisclosureRow,
  readAcks,
  readAcksByAgents,
  readAgents,
  readAllAgents,
  readAllArtifacts,
  readAllRecalls,
  readArtifacts,
  readDisclosures,
  readEndorsements,
  readHeartbeat,
  readHeartbeats,
  readLatestLoadout,
  readLatestLoadouts,
  readLifts,
  readRecallsBy,
  readTrustPolicies,
  readTrustPolicy,
} from "./reader"
import type { AckRow, ArtifactRow, EndorseRow, LiftRow, RecallRow } from "./types"

const PUBLIC_AGENT_LIMIT = 50

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

/**
 * The whole public list, from anyone, for pages that show it to anyone.
 *
 * Anyone can write a record, so nothing here says a recall is binding, only who issued it. Whether it binds an
 * agent depends on whether that agent's owner follows that key. Each recall can be ended only by its own issuer.
 */
export async function readWholeList(client: ArkivPublic): Promise<PublicView> {
  const [passports, { rows, block }, artifacts] = await Promise.all([readAllAgents(client, PUBLIC_AGENT_LIMIT), readAllRecalls(client), readAllArtifacts(client)])
  // One read of each kind for all the agents. One each per agent ran through an access key's quota in an afternoon.
  const addresses = passports.map((p) => p.agent)
  const [loadouts, heartbeats, policies] = await Promise.all([
    readLatestLoadouts(client, addresses),
    readHeartbeats(client, addresses),
    readTrustPolicies(client, [...new Set(passports.map((p) => p.owner.toLowerCase()))]),
  ])
  const agents = passports.map(
    (agent) =>
      ({
        agent,
        loadout: loadouts.get(agent.agent.toLowerCase()),
        heartbeat: heartbeats.get(agent.agent.toLowerCase()),
        policy: policies.get(agent.owner.toLowerCase()),
      }) satisfies BoardAgent,
  )
  // A STOP says who issued it and binds only those who follow that key. A report means nothing unless a verifier
  // checked the people behind it, so one from any other key is not shown at all.
  const recalls = rows.filter((r) => r.level === "STOP" || r.creator.toLowerCase() === ADDRESSES.verifier.toLowerCase()).sort((a, b) => Number(b.createdAt - a.createdAt))
  const keys = recalls.map((r) => r.key)
  const advisoryIssuers = [...new Set(recalls.filter((r) => r.level === "ADVISORY").map((r) => r.creator))]
  const [acks, lifts, endorsements, disclosures] = await Promise.all([
    readAcks(client, keys),
    readLifts(client, keys),
    Promise.all(
      advisoryIssuers.map((issuer) =>
        readEndorsements(
          client,
          recalls.filter((r) => r.level === "ADVISORY" && r.creator === issuer).map((r) => r.key),
          issuer,
        ),
      ),
    ).then((groups) => groups.flat()),
    readDisclosures(client, keys),
  ])
  const issuerOf = new Map(recalls.map((r) => [r.key, r.creator.toLowerCase()]))
  return {
    block,
    agents,
    recalls,
    acks,
    lifts,
    endorsements,
    artifacts,
    disclosures: disclosures.filter((d) => d.creator.toLowerCase() === issuerOf.get(d.recall)),
  }
}

/** What the scripted demo's pages show: only its own companies, and the keys they follow. */
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

  const [acks, lifts, endorsements, artifacts, disclosures] = await Promise.all([
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
