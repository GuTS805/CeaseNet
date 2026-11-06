import { readFileSync } from "node:fs"
import { type EndorseRow, type Hex, type LoadedFile, lower, recallCovers, type RecallRow } from "@ceasenet/core"
import { writeAtomic } from "@ceasenet/guard"
import { inHome } from "./home"

/**
 * Reports from people, as seen by an owner.
 *
 * Anyone can report an agent or a tool, once World ID has shown they are a real person, and others can vote the same
 * way. Votes stop nothing by themselves: a crowd must not be able to switch off someone's agent. At enough votes the
 * owner is told, and the decision is theirs.
 */
export const DEFAULT_VOTES_NEEDED = 3

export type ReportState = "collecting" | "waiting" | "recalled" | "dismissed"

export interface OwnAgent {
  name: string
  address: Hex
  /** Everything that names it or that it runs. A report covering any of these is about this agent. */
  files: readonly LoadedFile[]
}

export interface ReportView {
  key: Hex
  artifact: string
  reason: string
  /** Which of this owner's agents it concerns, and through what. */
  about: { agent: string; address: Hex; through: string }[]
  /** A person's name for what was reported. */
  target: string
  kind: "agent" | "tool"
  votes: number
  disputes: number
  /** Votes marked as stand-ins, from a test environment. Real people are never marked this way. */
  simulated: number
  votesNeeded: number
  state: ReportState
  recall?: Hex
  verifier: Hex
  block: string
  pkg?: string
  versions?: string
}

interface Handled {
  [report: string]: { state: "recalled" | "dismissed"; recall?: Hex; at: number }
}

const handledPath = () => inHome("reports-handled.json")

export function loadHandled(): Handled {
  try {
    return JSON.parse(readFileSync(handledPath(), "utf8")) as Handled
  } catch {
    return {}
  }
}

export function markHandled(report: Hex, state: "recalled" | "dismissed", recall?: Hex, at = Date.now()): void {
  writeAtomic(handledPath(), JSON.stringify({ ...loadHandled(), [report]: { state, recall, at } }))
}

/** Counts each person once, on whichever side they last came down. A verifier refuses a second answer anyway. */
function tally(votes: readonly EndorseRow[], report: RecallRow): { votes: number; disputes: number; simulated: number } {
  const relevant = votes.filter((v) => v.recall === report.key && lower(v.creator) === lower(report.creator))
  const yes = new Set(relevant.filter((v) => v.stance === "CONFIRM").map((v) => v.human))
  const no = new Set(relevant.filter((v) => v.stance === "DISPUTE").map((v) => v.human))
  return { votes: yes.size, disputes: no.size, simulated: [...yes].filter((h) => h.startsWith("simulated-")).length }
}

/** Reports about this owner's agents, newest first. Nothing about anyone else's is shown or counted. */
export function reportsFor(reports: readonly RecallRow[], votes: readonly EndorseRow[], agents: readonly OwnAgent[], votesNeeded: number, handled: Handled): ReportView[] {
  const views: ReportView[] = []
  for (const report of reports) {
    const about = agents.flatMap((agent) => {
      const file = agent.files.find((f) => recallCovers(report, f))
      return file ? [{ agent: agent.name, address: agent.address, through: file.kind === "tool" ? file.name : "the agent itself" }] : []
    })
    if (about.length === 0) continue
    const count = tally(votes, report)
    const done = handled[report.key]
    // Confirmations must outnumber disputes, or a report nobody agrees with would still bother its owner.
    const enough = count.votes >= votesNeeded && count.votes > count.disputes
    const isAgent = report.artifact.startsWith("agent:")
    views.push({
      key: report.key,
      artifact: report.artifact,
      reason: report.reason,
      about,
      target: isAgent ? about[0]!.agent : (report.pkg ?? report.artifact),
      kind: isAgent ? "agent" : "tool",
      ...count,
      votesNeeded,
      state: done ? done.state : enough ? "waiting" : "collecting",
      recall: done?.recall,
      verifier: report.creator,
      block: String(report.createdAt),
      pkg: report.pkg,
      versions: report.versions,
    })
  }
  return views.sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)))
}

/** What an owner's recall should say, so its reader can see where it came from. */
export const recallReasonFor = (report: Pick<ReportView, "reason" | "votes" | "simulated">): string =>
  `Reported by ${report.votes} ${report.votes === 1 ? "person" : "people"} checked by World ID${report.simulated ? ` (${report.simulated} simulated)` : ""}: ${report.reason}`
