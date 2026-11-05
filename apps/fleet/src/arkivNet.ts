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

/** A robot's connection to Arkiv. Every record it writes is created by its own key. */
export class ArkivRobotNet implements RobotNet {
  private heartbeatKey: Hex | undefined

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

  async writeHeartbeat(status: RobotStatus, seq: bigint): Promise<void> {
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
