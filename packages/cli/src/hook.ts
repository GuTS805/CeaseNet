import { readFileSync } from "node:fs"
import { GateRunner, PRODUCTION_TIMERS } from "@ceasenet/core"
import { fileStore, writeAtomic } from "@ceasenet/guard"
import { configExists, identityOf, inHome, loadConfig, nudgeTime, startingPolicy } from "./home"
import { ledgerFor } from "./ledger"

/**
 * MCP is only part of what an agent can do. Claude Code's own tools, such as Bash and file edits, never pass through
 * a gate in front of an MCP server, so stopping an agent has to reach them another way.
 *
 * Claude Code asks this command before each tool call. It answers with the same rules as every gate: only a STOP from
 * a key the owner follows counts, a deleted STOP stays in force, and losing the list goes through grace, then asking
 * a person, then refusing.
 */
export type HookAnswer =
  | { kind: "allow" }
  /** Claude Code refuses the call, and gives this reason to the model. */
  | { kind: "refuse"; reason: string }
  /** Claude Code asks the person at the keyboard. */
  | { kind: "ask"; reason: string }

/** A burst of calls should not mean a burst of reads. A change made on this machine is noticed straight away. */
const CACHE_MS = 1_500
const CACHE_FILE = "hook-cache.json"

interface Cache {
  at: number
  nudge: number
}

const readCache = (): Cache | undefined => {
  try {
    return JSON.parse(readFileSync(inHome(CACHE_FILE), "utf8")) as Cache
  } catch {
    return undefined
  }
}

export async function askHook(now = Date.now()): Promise<HookAnswer> {
  // Not set up, or removed: this is not ours to judge.
  if (!configExists()) return { kind: "allow" }

  // Only ever a recent "allowed". A refusal is worked out afresh each time, so it always says why.
  const cache = readCache()
  const nudge = nudgeTime()
  if (cache && now - cache.at < CACHE_MS && cache.nudge === nudge) return { kind: "allow" }

  const config = loadConfig()
  const net = ledgerFor(config).readOnlyNet()
  const runner = new GateRunner({
    policy: startingPolicy(config.owner.address),
    timers: PRODUCTION_TIMERS,
    store: fileStore(inHome("gates", "_hook.json")),
  })
  const result = await runner.check(identityOf(config), (policy, remembered) => net.readView(policy, remembered))
  const { mode, reasons } = result.decision.core

  if (mode === "STOPPED") {
    const stop = reasons.find((r) => r.type === "STOP")
    return {
      kind: "refuse",
      reason:
        stop && "recall" in stop
          ? `CeaseNet refused this: the owner of this agent has stopped it. Reason: ${stop.recall.reason.replace(/[.\s]+$/, "")}. Do not try this or any other tool again until a person restarts it.`
          : "CeaseNet refused this: it has not been able to read the recall list for too long. It stays refused until it can.",
    }
  }
  if (mode === "SUPERVISED") return { kind: "ask", reason: "CeaseNet cannot reach the recall list, so a person must approve each action until it can." }

  writeAtomic(inHome(CACHE_FILE), JSON.stringify({ at: now, nudge } satisfies Cache))
  return { kind: "allow" }
}

/** Answers Claude Code in the form it expects. Refusing is exit code 2, with the reason on stderr. */
export async function runHook(): Promise<void> {
  // Claude Code writes the call on our stdin. Nothing about it changes the answer, since it applies to everything.
  process.stdin.resume()
  process.stdin.on("error", () => undefined)
  let answer: HookAnswer
  try {
    answer = await askHook()
  } catch (e) {
    // Something is wrong with this machine's own records, so it cannot be known whether this agent has been stopped.
    answer = { kind: "refuse", reason: `CeaseNet could not check whether this agent has been stopped: ${(e as Error).message.split("\n")[0]}. A person can run: ceasenet unprotect` }
  }
  if (answer.kind === "refuse") {
    process.stderr.write(`${answer.reason}\n`)
    process.exit(2)
  }
  if (answer.kind === "ask") {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: answer.reason } })}\n`)
  }
  process.exit(0)
}
