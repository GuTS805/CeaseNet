import {
  type AckIntent,
  type AgentStatus,
  type ArkivPublic,
  ArkivWriter,
  type GateView,
  type Hex,
  type LoadedFile,
  readGateView,
  readHeartbeat,
  type TrustPolicy,
} from "@ceasenet/core"
import type { GuardNet } from "./guard"

/**
 * Runs one task at a time and keeps only the newest waiting input.
 *
 * Heartbeats report the present, so an old one waiting in line is worthless, and a queue of them would
 * hold up receipts.
 */
export function latestOnly<T>(task: (input: T) => Promise<void>): (input: T) => Promise<void> {
  let running = false
  let waiting: { input: T } | undefined
  return async (input) => {
    waiting = { input }
    if (running) return
    running = true
    try {
      while (waiting) {
        const next = waiting
        waiting = undefined
        await task(next.input)
      }
    } finally {
      running = false
    }
  }
}

/** Reads the recall list without writing anything, for owners who want protection and no public footprint. */
export class ReadOnlyNet implements GuardNet {
  constructor(
    private readonly client: ArkivPublic,
    private readonly owner: string | undefined,
  ) {}

  readView(policy: TrustPolicy, remembered: readonly Hex[]): Promise<GateView> {
    return readGateView(this.client, this.owner, policy, remembered)
  }

  async writeLoadout(_seq: bigint, _files: LoadedFile[]): Promise<void> {}
  async writeHeartbeat(_status: AgentStatus, _seq: bigint): Promise<void> {}
  async writeAck(_intent: AckIntent, _newHash?: string): Promise<void> {}
  async extendRecall(_key: Hex): Promise<void> {}
}

/** An agent's connection to Arkiv. Every record it writes is created by its own key. */
export class ArkivGuardNet extends ReadOnlyNet implements GuardNet {
  private heartbeatKey: Hex | undefined
  private lastSent: { status: AgentStatus; seq: bigint } | undefined
  private readonly sendBeat = latestOnly<{ status: AgentStatus; seq: bigint }>((b) => this.writeBeat(b.status, b.seq))

  constructor(
    private readonly reader: ArkivPublic,
    owner: string | undefined,
    private readonly writer: ArkivWriter,
    private readonly heartbeatTtlSeconds: number,
  ) {
    super(reader, owner)
  }

  override async writeLoadout(seq: bigint, files: LoadedFile[]): Promise<void> {
    await this.writer.loadout({ seq, files })
  }

  override writeHeartbeat(status: AgentStatus, seq: bigint): Promise<void> {
    return this.sendBeat({ status, seq })
  }

  private async writeBeat(status: AgentStatus, seq: bigint): Promise<void> {
    const input = { mode: status, loadoutSeq: seq, ttlSeconds: this.heartbeatTtlSeconds }
    if (!this.heartbeatKey) {
      const existing = await readHeartbeat(this.reader, this.writer.address)
      if (existing) {
        this.heartbeatKey = existing.key
        this.lastSent = { status: existing.mode, seq: existing.loadoutSeq }
      }
    }
    if (!this.heartbeatKey) return this.createBeat(status, seq)

    const unchanged = this.lastSent?.status === status && this.lastSent.seq === seq
    try {
      if (unchanged) await this.writer.extendHeartbeat(this.heartbeatKey, this.heartbeatTtlSeconds)
      else await this.writer.updateHeartbeat(this.heartbeatKey, input)
      this.lastSent = { status, seq }
    } catch (e) {
      // A new heartbeat is right only if the old one really is gone, such as after time offline.
      // Any other failure must be reported, not papered over with another record.
      const existing = await readHeartbeat(this.reader, this.writer.address)
      if (existing?.key === this.heartbeatKey) throw e
      await this.createBeat(status, seq)
    }
  }

  private async createBeat(status: AgentStatus, seq: bigint): Promise<void> {
    const { entityKey } = await this.writer.createHeartbeat({
      mode: status,
      loadoutSeq: seq,
      ttlSeconds: this.heartbeatTtlSeconds,
    })
    this.heartbeatKey = entityKey
    this.lastSent = { status, seq }
  }

  override async writeAck(intent: AckIntent, newHash?: string): Promise<void> {
    await this.writer.ack({
      recall: intent.recall.key,
      recallHash: intent.recall.contentHash,
      agent: this.writer.address,
      artifact: intent.recall.artifact,
      action: intent.action,
      issuer: intent.recall.creator,
      newHash,
    })
  }

  override async extendRecall(key: Hex): Promise<void> {
    await this.writer.extendRecall(key)
  }
}
