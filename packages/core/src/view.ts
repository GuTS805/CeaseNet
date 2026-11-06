import type { ArkivPublic } from "./arkiv"
import { type BoardAgent, follows, isLive } from "./board"
import { lower, ownerOnlyPolicy, recallCovers } from "./gate"
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

/** Its own issuer has taken this recall back. A recall that was fixed still stands against the version it named. */
export const endedByIssuer = (recall: RecallRow, lifts: readonly LiftRow[]): boolean =>
  lifts.some((l) => l.recall === recall.key && l.kind === "WITHDRAWN" && lower(l.creator) === lower(recall.creator))

/**
 * What is happening now: agents with a live heartbeat, and the recalls in force that cover one of them.
 *
 * Records stay on Arkiv until they expire, whoever wrote them, so the public list fills up with agents that ran once.
 * This narrows what a page leads with, by a fact anyone can check. It does not remove anything from the record.
 */
export function onlyLive(view: PublicView): PublicView {
  const agents = view.agents.filter(isLive)
  return {
    ...view,
    agents,
    recalls: view.recalls.filter((r) => !endedByIssuer(r, view.lifts) && agents.some((a) => a.policy && follows(a.policy, r) && a.loadout?.files.some((f) => recallCovers(r, f)))),
  }
}

/**
 * The whole public list, from anyone, for pages that show it to anyone.
 *
 * Anyone can write a record, so nothing here says a recall is binding, only who issued it. A STOP binds an agent only
 * when the agent's owner signed it. Each recall can be ended only by its own issuer.
 */
export async function readWholeList(client: ArkivPublic): Promise<PublicView> {
  const [passports, { rows, block }, artifacts] = await Promise.all([readAllAgents(client, PUBLIC_AGENT_LIMIT), readAllRecalls(client), readAllArtifacts(client)])
  // One read of each kind for all the agents. One each per agent ran through an access key's quota in an afternoon.
  const addresses = passports.map((p) => p.agent)
  const [loadouts, heartbeats] = await Promise.all([readLatestLoadouts(client, addresses), readHeartbeats(client, addresses)])
  const agents = passports.map(
    (agent) =>
      ({
        agent,
        loadout: loadouts.get(agent.agent.toLowerCase()),
        heartbeat: heartbeats.get(agent.agent.toLowerCase()),
        // An agent obeys its owner and nobody else, whatever list was published for it before.
        policy: ownerOnlyPolicy(agent.owner),
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
