import {
  ackId,
  acksOwed,
  type AckIntent,
  type AgentDecision,
  countConfirmations,
  evaluateAgent,
  fixFor,
  isTrustedStop,
  recallCovers,
  type TrustConfig,
  trustFromPolicy,
  vanishedStops,
} from "./gate"
import type { GateView } from "./reader"
import type { Timers } from "./timers"
import type { AckAction, Hex, LiftRow, LoadedFile, RecallRow, TrustPolicy } from "./types"

/** What a gate must not forget, even across restarts. */
export interface GateMemory {
  stops: RecallRow[]
  lifts: LiftRow[]
  acked: string[]
  supervised: RecallRow[]
  /** STOPs that vanished from Arkiv without a lift. */
  vanished: Hex[]
  /** The owner's trust list as last read, so it still applies while Arkiv cannot be reached. */
  policy?: TrustPolicy
  /** When the list was last read. Kept so that restarting during an outage cannot buy a new grace period. */
  lastReadOk?: number
}

export interface GateStore {
  load(): GateMemory | undefined
  save(memory: GateMemory): void
}

export const memoryStore = (): GateStore => {
  let m: GateMemory | undefined
  return { load: () => m, save: (next) => void (m = next) }
}

/** Saves bigints as strings, so memory can live in a JSON file. */
export function encodeMemory(memory: GateMemory): string {
  return JSON.stringify(memory, (_k, v) => (typeof v === "bigint" ? `#${v}` : v))
}

export function decodeMemory(text: string): GateMemory {
  return JSON.parse(text, (_k, v) => (typeof v === "string" && /^#\d+$/.test(v) ? BigInt(v.slice(1)) : v))
}

export interface AdvisoryStatus {
  recall: RecallRow
  confirms: number
  disputes: number
  effective: number
}

export interface CheckResult {
  decision: AgentDecision
  acks: AckIntent[]
  online: boolean
  block: bigint
  /** A fix exists for a STOP this agent is under: moving to the fixed version gets it working again. */
  fixes: { stop: RecallRow; lift: LiftRow; file: LoadedFile }[]
  advisories: AdvisoryStatus[]
  vanished: RecallRow[]
  /** Active STOPs close to expiring, which this agent should extend. */
  toExtend: Hex[]
  policy: TrustPolicy
}

/** STOPs with less than this many blocks left get extended. About two weeks. */
const EXTEND_BELOW_BLOCKS = 600_000n

/**
 * Runs the gate for an agent: reads Arkiv, remembers what it must not forget, and works out what is allowed.
 *
 * Reads fail closed. If Arkiv cannot be read, the agent goes through grace, then human approval, then stop.
 */
export class GateRunner {
  private memory: GateMemory
  private lastReadOk: number
  private lastBlock = 0n
  private policy: TrustPolicy

  constructor(
    private readonly options: {
      /** Used until the owner's own list has been read. */
      policy: TrustPolicy
      timers: Pick<Timers, "graceMs" | "offlineSupervisedMs">
      store: GateStore
      now?: () => number
    },
  ) {
    this.memory = options.store.load() ?? { stops: [], lifts: [], acked: [], supervised: [], vanished: [] }
    this.policy = this.memory.policy ?? options.policy
    this.lastReadOk = this.memory.lastReadOk ?? this.now()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  get trust(): TrustConfig {
    return trustFromPolicy(this.policy)
  }

  /** Keys whose lifts must keep being read, because this gate remembers them. */
  rememberedKeys(): Hex[] {
    return this.memory.stops.map((s) => s.key)
  }

  /** @param read reads Arkiv and throws if it cannot. */
  async check(
    files: readonly LoadedFile[],
    read: (policy: TrustPolicy, remembered: readonly Hex[]) => Promise<GateView>,
  ): Promise<CheckResult> {
    const { timers } = this.options
    let view: GateView | undefined
    try {
      view = await read(this.policy, this.rememberedKeys())
    } catch {
      view = undefined
    }

    const online = view !== undefined
    if (view) {
      this.lastReadOk = this.now()
      this.memory.lastReadOk = this.lastReadOk
      this.lastBlock = view.block
      if (view.policy) {
        this.policy = view.policy
        this.memory.policy = view.policy
      }
    }
    const trust = this.trust
    if (view) {
      this.mergeStops(view.stops.filter((s) => isTrustedStop(s, trust)))
      this.mergeLifts(view.lifts)
    }

    const decision = evaluateAgent({
      files,
      rememberedStops: this.memory.stops,
      rememberedLifts: this.memory.lifts,
      advisories: view?.advisories ?? [],
      endorsements: view?.endorsements ?? [],
      currentBlock: this.lastBlock,
      connectivity: { online, offlineForMs: online ? 0 : this.now() - this.lastReadOk },
      lastSupervised: this.memory.supervised,
      trust,
      timers,
    })

    const previouslySupervised = this.memory.supervised
    const acks = online ? acksOwed(decision, previouslySupervised, new Set(this.memory.acked)) : []

    const decisions = [decision.core, ...decision.tools.map((t) => t.decision)]
    const stops = dedupe(decisions.flatMap((d) => d.activeStops))
    if (online) {
      this.memory.supervised = dedupe(decisions.flatMap((d) => d.activeAdvisories))
    }

    const stopsOnMyFiles = this.memory.stops.filter((s) => files.some((f) => recallCovers(s, f)))
    const vanished = view
      ? vanishedStops(stopsOnMyFiles, view.stops, this.memory.lifts, trust)
      : this.memory.stops.filter((s) => this.memory.vanished.includes(s.key))
    this.memory.vanished = [...new Set([...this.memory.vanished, ...vanished.map((s) => s.key)])]

    this.options.store.save(this.memory)

    return {
      decision,
      acks,
      online,
      block: this.lastBlock,
      fixes: stops.flatMap((stop) => {
        const lift = fixFor(stop, this.memory.lifts, trust)
        const file = files.find((f) => recallCovers(stop, f))
        return lift && file ? [{ stop, lift, file }] : []
      }),
      advisories: (view?.advisories ?? []).map((recall) => ({
        recall,
        ...countConfirmations(recall, view?.endorsements ?? [], this.lastBlock, trust),
      })),
      vanished,
      toExtend: view
        ? stops
            .filter((s) => view!.stops.some((v) => v.key === s.key))
            .filter((s) => s.expiresAt - this.lastBlock < EXTEND_BELOW_BLOCKS)
            .map((s) => s.key)
        : [],
      policy: this.policy,
    }
  }

  markAcked(recall: Hex, action: AckAction): void {
    const id = ackId(recall, action)
    if (!this.memory.acked.includes(id)) {
      this.memory.acked.push(id)
      this.options.store.save(this.memory)
    }
  }

  private mergeStops(stops: readonly RecallRow[]): void {
    const known = new Set(this.memory.stops.map((s) => s.key))
    for (const s of stops) if (!known.has(s.key)) this.memory.stops.push(s)
  }

  private mergeLifts(lifts: readonly LiftRow[]): void {
    const known = new Set(this.memory.lifts.map((l) => l.key))
    for (const l of lifts) if (!known.has(l.key)) this.memory.lifts.push(l)
  }
}

const dedupe = (rows: readonly RecallRow[]): RecallRow[] => [...new Map(rows.map((r) => [r.key, r])).values()]
