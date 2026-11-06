import { hashBytes } from "./hash"
import type { Hex, LoadedFile } from "./types"

/**
 * Stopping an agent, rather than one of its tools.
 *
 * A running agent counts itself and its fleet among the things it has loaded, under names only its owner's
 * STOP will name. A recalled model or prompt already stops the whole agent, so an agent or a fleet stops by the
 * same rule, with no new path through the gate. Lifting that STOP starts it again.
 */
export const agentArtifact = (agent: string): string => `agent:${agent.toLowerCase()}`
export const fleetArtifact = (owner: string): string => `fleet:${owner.toLowerCase()}`
/** A group of agents that can be stopped together, leaving anything else the same owner runs alone. */
export const teamArtifact = (owner: string): string => `team:${owner.toLowerCase()}`
export const teamFile = (owner: string): LoadedFile => ({ kind: "team", name: "team", version: "1.0.0", hash: teamArtifact(owner) })

export const identityFiles = (agent: string, owner: string): LoadedFile[] => [
  { kind: "agent", name: "agent", version: "1.0.0", hash: agentArtifact(agent) },
  { kind: "fleet", name: "fleet", version: "1.0.0", hash: fleetArtifact(owner) },
]

const isIdentity = (file: LoadedFile) => file.kind === "agent" || file.kind === "fleet" || file.kind === "team"

/**
 * What an agent is made of, in one value: its exact tools, model and instructions.
 * It leaves out who the agent is, so two agents built the same way share one, and any change to what one runs changes it.
 */
export const agentFingerprint = (files: readonly LoadedFile[]): Hex =>
  hashBytes(
    files
      .filter((f) => !isIdentity(f))
      .map((f) => `${f.kind}:${f.name}:${f.version}:${f.hash.toLowerCase()}`)
      .sort()
      .join("\n"),
  )

/** Whether a recall stops a whole agent or fleet, rather than one tool. */
export const isKillRecall = (artifact: string): boolean => artifact.startsWith("agent:") || artifact.startsWith("fleet:") || artifact.startsWith("team:")
