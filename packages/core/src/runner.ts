import {
  ackId,
  acksOwed,
  type AckIntent,
  countConfirmations,
  evaluate,
  fixFor,
  type GateDecision,
  isTrustedStop,
  lower,
  type TrustConfig,
  vanishedStops,
} from "./gate"
import type { GateView } from "./reader"
import type { Timers } from "./timers"
import type { AckAction, Hex, LiftRow, RecallRow } from "./types"

/** What a gate must not forget, even across restarts. */
export interface GateMemory {
  stops: RecallRow[]
  lifts: LiftRow[]
  acked: string[]
  supervised: RecallRow[]
  /** STOPs that vanished from Arkiv without a lift. */
  vanished: Hex[]
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
  decision: GateDecision
  acks: AckIntent[]
  online: boolean
  block: bigint
  /** A fix exists for a STOP this robot is under: installing the fixed file gets it working again. */
  fixes: { stop: RecallRow; lift: LiftRow }[]
  advisories: AdvisoryStatus[]
  vanished: RecallRow[]
  /** Active STOPs close to expiring, which this robot should extend. */
  toExtend: Hex[]
}

/** STOPs with less than this many blocks left get extended. About two weeks. */
const EXTEND_BELOW_BLOCKS = 600_000n

/**
 * Runs the gate on a robot: reads Arkiv, remembers what it must not forget, and works out what to do.
 *
 * Reads fail closed. If Arkiv cannot be read, the robot goes through grace, then supervised, then stop.
 */
export class GateRunner {
  private memory: GateMemory
  private lastReadOk: number
  private lastBlock = 0n

  constructor(
    private readonly options: {
      trust: TrustConfig
      timers: Pick<Timers, "graceMs" | "offlineSupervisedMs">
      store: GateStore
      now?: () => number
    },
  ) {
    this.memory = options.store.load() ?? { stops: [], lifts: [], acked: [], supervised: [], vanished: [] }
    this.lastReadOk = this.now()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Keys whose lifts must keep being read, because this gate remembers them. */
  rememberedKeys(): Hex[] {
    return this.memory.stops.map((s) => s.key)
  }

  /** @param read reads Arkiv and throws if it cannot. */
  async check(hashes: readonly string[], read: () => Promise<GateView>): Promise<CheckResult> {
    const { trust, timers } = this.options
    let view: GateView | undefined
    try {
      view = await read()
    } catch {
      view = undefined
    }

    const online = view !== undefined
    if (view) {
      this.lastReadOk = this.now()
      this.lastBlock = view.block
      this.mergeStops(view.stops.filter((s) => isTrustedStop(s, trust)))
      this.mergeLifts(view.lifts)
    }

    const decision = evaluate({
      hashes,
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

    if (online) {
      this.memory.supervised = decision.activeAdvisories
    }

    const liveHashes = new Set(hashes.map(lower))
    const stopsOnMyFiles = this.memory.stops.filter((s) => liveHashes.has(lower(s.artifact)))
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
      fixes: decision.activeStops.flatMap((stop) => {
        const lift = fixFor(stop, this.memory.lifts, trust)
        return lift ? [{ stop, lift }] : []
      }),
      advisories: (view?.advisories ?? []).map((recall) => ({
        recall,
        ...countConfirmations(recall, view?.endorsements ?? [], this.lastBlock, trust),
      })),
      vanished,
      toExtend: view
        ? decision.activeStops
            .filter((s) => view!.stops.some((v) => v.key === s.key))
            .filter((s) => s.expiresAt - this.lastBlock < EXTEND_BELOW_BLOCKS)
            .map((s) => s.key)
        : [],
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
