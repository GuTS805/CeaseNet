import {
  agentArtifact,
  fleetArtifact,
  teamArtifact,
  type Hex,
  isKillRecall,
  type LiftRow,
  type RecallRow,
  type TrustPolicy,
} from "@ceasenet/core"
import { type Config, loadKeys, nudge, obeyingOwner, startingPolicy } from "./home"
import { type Ledger, type LedgerWriter } from "./ledger"

const FAUCET = "https://hub.arkiv.network/faucet"

/** Says what is wrong with a write in a way that tells the owner what to do. */
export function explainWriteError(e: unknown, address: string): Error {
  const text = e instanceof Error ? e.message : String(e)
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text)) return noFunds(address)
  const first = text.split("\n")[0] ?? "the write failed"
  // What Arkiv says when a transaction cannot even be estimated, which an empty wallet is one cause of.
  if (/without revert data/i.test(text)) return new Error(`${first}. If the wallet ${address} is low on tGLM, claim some at ${FAUCET}.`)
  return new Error(first)
}

const noFunds = (address: string) => new Error(`The wallet ${address} has no tGLM to pay for this. Claim some at ${FAUCET} and try again.`)

/** The owner's voice on this machine. Without their key here, this machine can obey them but not speak for them. */
export function ownerWriter(ledger: Ledger, config: Config): LedgerWriter {
  const key = loadKeys().owner
  if (!key) {
    throw new Error(`The owner's key (${config.owner.address}) is not on this machine. Do this from the machine that holds it.`)
  }
  return ledger.writer(key)
}

async function speaking<T>(ledger: Ledger, writer: LedgerWriter, task: () => Promise<T>): Promise<T> {
  // The chain's own answer to an empty wallet says nothing useful, so it is not asked.
  if ((await ledger.balance(writer.address).catch(() => undefined)) === 0n) throw noFunds(writer.address)
  try {
    const result = await task()
    // Guards on this machine read the list at once, rather than at their next turn.
    nudge()
    return result
  } catch (e) {
    throw explainWriteError(e, writer.address)
  }
}

export interface StopToolInput {
  /** The exact file this recall names, when it is known. */
  hash?: string
  name?: string
  /** A version range such as ">=1.0.16 <1.0.17". Applies with a name. */
  versions?: string
  reason: string
  severity?: string
  advice?: string
}

/** Stops one tool: that exact file, or a package across a range of versions. */
export function stopTool(ledger: Ledger, config: Config, input: StopToolInput): Promise<{ entityKey: Hex }> {
  if (!input.reason.trim()) throw new Error("A recall needs a reason, because that is what the agent and everyone else will read.")
  if (!input.hash && !input.name) throw new Error("Say which tool to stop.")
  const writer = ownerWriter(ledger, config)
  return speaking(ledger, writer, () =>
    writer.stop({
      artifact: input.hash ?? `package:${input.name}`,
      severity: input.severity ?? "HIGH",
      reason: input.reason.trim(),
      advice: input.advice,
      ...(input.name ? { pkg: input.name, versions: input.versions ?? "*" } : {}),
    }),
  )
}

/** Stops a whole agent, whichever tools it has. It needs the key of the owner it answers to. */
export function stopAgent(ledger: Ledger, config: Config, agent: string, reason: string): Promise<{ entityKey: Hex }> {
  if (!reason.trim()) throw new Error("Stopping an agent needs a reason, because that is what it will be told.")
  const writer = ownerWriter(ledger, config)
  return speaking(ledger, writer, () => writer.stop({ artifact: agentArtifact(agent), severity: "CRITICAL", reason: reason.trim() }))
}

/** Stops every agent this owner answers for, wherever they run. */
export function stopFleet(ledger: Ledger, config: Config, reason: string): Promise<{ entityKey: Hex }> {
  if (!reason.trim()) throw new Error("Stopping your agents needs a reason, because that is what they will be told.")
  const writer = ownerWriter(ledger, config)
  return speaking(ledger, writer, () => writer.stop({ artifact: fleetArtifact(config.owner.address), severity: "CRITICAL", reason: reason.trim() }))
}

/** Stops the team of three together, and nothing else this owner runs. */
export function stopTeam(ledger: Ledger, config: Config, reason: string): Promise<{ entityKey: Hex }> {
  if (!reason.trim()) throw new Error("Stopping them needs a reason, because that is what they will be told.")
  const writer = ownerWriter(ledger, config)
  return speaking(ledger, writer, () => writer.stop({ artifact: teamArtifact(config.owner.address), severity: "CRITICAL", reason: reason.trim() }))
}

/** Ends a recall. Agents that obeyed it carry on. */
export async function liftRecall(ledger: Ledger, config: Config, recall: Hex, note?: string): Promise<{ entityKey: Hex }> {
  const writer = ownerWriter(ledger, config)
  const { rows } = await ledger.recalls([config.owner.address])
  const found = rows.find((r) => r.key.toLowerCase() === recall.toLowerCase())
  if (!found) throw new Error(`You did not issue a recall with the key ${recall}, so you cannot lift it.`)
  return speaking(ledger, writer, () => writer.lift({ recall: found.key, artifact: found.artifact, kind: "WITHDRAWN", note }))
}

/** Publishes a fix: agents still on the recalled file stay blocked, and this names the file to move to. */
export async function publishFix(ledger: Ledger, config: Config, recall: Hex, fixedHash: string, fixedVersion: string, note?: string): Promise<{ entityKey: Hex }> {
  const writer = ownerWriter(ledger, config)
  const { rows } = await ledger.recalls([config.owner.address])
  const found = rows.find((r) => r.key.toLowerCase() === recall.toLowerCase())
  if (!found) throw new Error(`You did not issue a recall with the key ${recall}.`)
  return speaking(ledger, writer, () => writer.lift({ recall: found.key, artifact: found.artifact, kind: "FIX", fixedHash, fixedVersion, note }))
}

export async function currentPolicy(ledger: Ledger, config: Config): Promise<TrustPolicy> {
  const owner = config.owner.address
  return obeyingOwner((await ledger.publishedPolicy(owner)) ?? startingPolicy(owner), owner)
}

/** Changes whose STOPs this owner's agents obey. An owner cannot remove themselves. */
export async function setFollowing(ledger: Ledger, config: Config, address: string, follow: boolean): Promise<TrustPolicy> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address.`)
  const owner = config.owner.address
  if (!follow && address.toLowerCase() === owner.toLowerCase()) throw new Error("You always obey your own STOPs, so you can stop your own agents.")
  const writer = ownerWriter(ledger, config)
  const current = await currentPolicy(ledger, config)
  const others = current.issuers.filter((i) => i.toLowerCase() !== address.toLowerCase())
  const policy: TrustPolicy = { ...current, issuers: follow ? [...others, address] : others }
  await speaking(ledger, writer, () => writer.trustList({ seq: BigInt(Date.now()), policy }))
  return policy
}

/**
 * Registers this agent and publishes the owner's trust list, once there is money to do it with.
 * Safe to call repeatedly: it does only what has not been done yet.
 */
export async function publishIdentity(ledger: Ledger, config: Config): Promise<string[]> {
  const key = loadKeys().owner
  if (!key) return []
  const writer = ledger.writer(key)
  const owner = config.owner.address
  const done: string[] = []
  if (!(await ledger.publishedPolicy(owner))) {
    await writer.trustList({ seq: BigInt(Date.now()), policy: startingPolicy(owner) })
    done.push("published your trust list")
  }
  const registered = await ledger.agents(owner)
  if (!registered.some((a) => a.agent.toLowerCase() === config.agent.address.toLowerCase())) {
    await writer.agent({ agent: config.agent.address, name: config.agent.name, framework: "MCP", purpose: "An agent guarded by CeaseNet." })
    done.push(`registered ${config.agent.name}`)
  }
  return done
}

/** Registers an agent that runs elsewhere, so it appears among this owner's agents and can be stopped by address. */
export function enrollAgent(ledger: Ledger, config: Config, agent: Hex, name: string): Promise<{ entityKey: Hex }> {
  const writer = ownerWriter(ledger, config)
  return speaking(ledger, writer, () => writer.agent({ agent, name, framework: "MCP", purpose: "An agent guarded by CeaseNet." }))
}

/** A recall counts as ended only when its issuer or a regulator says so. */
export function isEnded(recall: RecallRow, lifts: readonly LiftRow[], policy: TrustPolicy): boolean {
  const regulators = policy.regulators.map((r) => r.toLowerCase())
  return lifts.some((l) => {
    const by = l.creator.toLowerCase()
    return l.recall === recall.key && l.kind === "WITHDRAWN" && (by === recall.creator.toLowerCase() || regulators.includes(by))
  })
}

export { isKillRecall }

/** A recall as the console's pages see it. */
export interface RecallLike extends RecallRow {
  ended: boolean
  mine: boolean
  receiptAgents?: string[]
}
