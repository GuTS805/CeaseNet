import {
  type AckIntent,
  type ArkivPublic,
  ArkivWriter,
  type GateView,
  type Hex,
  type LoadedFile,
  readGateView,
  readHeartbeat,
  type TrustConfig,
} from "@ceasenet/core"
import type { RobotNet, RobotStatus } from "./robot"

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

/** A robot's connection to Arkiv. Every record it writes is created by its own key. */
export class ArkivRobotNet implements RobotNet {
  private heartbeatKey: Hex | undefined
  private readonly sendBeat = latestOnly<{ status: RobotStatus; seq: bigint }>((b) => this.writeBeat(b.status, b.seq))

  constructor(
    private readonly client: ArkivPublic,
    private readonly writer: ArkivWriter,
    private readonly trust: TrustConfig,
    private readonly heartbeatTtlSeconds: number,
  ) {}

  readView(hashes: readonly string[], remembered: readonly Hex[]): Promise<GateView> {
    return readGateView(this.client, hashes, this.trust, remembered)
  }

  async writeLoadout(seq: bigint, files: LoadedFile[]): Promise<void> {
    await this.writer.loadout({ seq, files })
  }

  writeHeartbeat(status: RobotStatus, seq: bigint): Promise<void> {
    return this.sendBeat({ status, seq })
  }

  private async writeBeat(status: RobotStatus, seq: bigint): Promise<void> {
    const input = { mode: status, loadoutSeq: seq, ttlSeconds: this.heartbeatTtlSeconds }
    if (!this.heartbeatKey) {
      this.heartbeatKey = (await readHeartbeat(this.client, this.writer.address))?.key
    }
    if (this.heartbeatKey) {
      try {
        await this.writer.updateHeartbeat(this.heartbeatKey, input)
        return
      } catch {
        // The heartbeat expired while the robot was offline. Start a new one.
        this.heartbeatKey = undefined
      }
    }
    const { entityKey } = await this.writer.createHeartbeat(input)
    this.heartbeatKey = entityKey
  }

  async writeAck(intent: AckIntent, artifact: string, newHash?: string): Promise<void> {
    await this.writer.ack({
      recall: intent.recall.key,
      recallHash: intent.recall.contentHash,
      robot: this.writer.address,
      artifact,
      action: intent.action,
      issuer: intent.recall.creator,
      newHash,
    })
  }

  async extendRecall(key: Hex): Promise<void> {
    await this.writer.extendRecall(key)
  }
}
