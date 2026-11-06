import { ExpirationTime } from "@arkiv-network/sdk"
import { addr, key, u64 } from "@arkiv-network/sdk/schema"
import { stringToBytes } from "viem"
import type { ArkivWallet } from "./arkiv"
import { recallContentHash } from "./hash"
import { Ack, Agent, Artifact, Diary, Disclose, Endorse, Heartbeat, Lift, Loadout, Recall, TrustList } from "./schema"
import { assertPublicRef } from "./swarmRef"
import type { AckAction, AgentStatus, Hex, LiftKind, LoadedFile, Stance, TrustPolicy } from "./types"

const READ_ONLY = { readonly: true } as const
/** Nobody can edit a STOP, and anyone can keep it alive, so it cannot quietly lapse. */
const STOP_FLAGS = { readonly: true, permissionlessExtension: true } as const
const LONG = () => ExpirationTime.fromDays(180)

/** Plenty for one patch and one extension. Only the gas actually used is charged. */
const HEARTBEAT_PATCH_GAS = 500_000n

const isOutOfGas = (e: unknown) => e instanceof Error && e.message.includes("ran out of gas")

const text = (value: string | undefined) => (value === undefined ? undefined : stringToBytes(value))

/** Drops unset optional values, which the SDK treats as missing columns. */
function clean<T extends Record<string, unknown>>(values: T): T {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as T
}

export interface RecallInput {
  artifact: string
  severity: string
  reason: string
  sealedEvidence?: string
  advice?: string
  pkg?: string
  versions?: string
}

/**
 * Writes one key's records. Transactions from one key must go out one at a time, or they collide on
 * the nonce, so every write joins a queue.
 */
export class ArkivWriter {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly wallet: ArkivWallet) {}

  get address(): Hex {
    return this.wallet.account!.address
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const attempt = async () => {
      try {
        return await task()
      } catch (e) {
        // The gas estimate is made before the state changes, so it can come up short. Nothing was applied,
        // and the SDK's own advice is to send it again. This matters most for a STOP.
        if (isOutOfGas(e)) return task()
        throw e
      }
    }
    const run = this.queue.then(attempt, attempt)
    this.queue = run.catch(() => undefined)
    return run
  }

  stop(input: RecallInput) {
    return this.enqueue(() => this.writeRecall("STOP", input))
  }

  advisory(input: RecallInput) {
    return this.enqueue(() => this.writeRecall("ADVISORY", input))
  }

  private writeRecall(level: "STOP" | "ADVISORY", input: RecallInput) {
    const artifact = input.artifact.toLowerCase()
    const contentHash = recallContentHash({ artifact, level, severity: input.severity, reason: input.reason })
    return this.wallet.createEntity(
      Recall,
      clean({
        artifact,
        level,
        severity: input.severity,
        reason: text(input.reason),
        contentHash,
        sealedEvidence: text(input.sealedEvidence),
        advice: text(input.advice),
        pkg: input.pkg,
        versions: input.versions,
      }) as any,
      level === "STOP"
        ? { expiration: ExpirationTime.max(), flags: STOP_FLAGS }
        : { expiration: ExpirationTime.fromHours(72), flags: READ_ONLY },
    )
  }

  /** Keeps a STOP alive. Works from any key because STOPs allow anyone to extend them. */
  extendRecall(entityKey: Hex) {
    return this.enqueue(() => this.wallet.extendEntity({ entityKey, expiration: ExpirationTime.max() }))
  }

  /** Keeps an advisory alive while confirmations keep arriving. The gate still enforces the 72-hour window. */
  extendAdvisory(entityKey: Hex) {
    return this.enqueue(() => this.wallet.extendEntity({ entityKey, expiration: ExpirationTime.fromHours(72) }))
  }

  deleteRecord(entityKey: Hex) {
    return this.enqueue(() => this.wallet.deleteEntity({ entityKey }))
  }

  endorse(input: { recall: Hex; stance: Stance; human: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Endorse,
        { recall: key(input.recall), stance: input.stance, human: input.human },
        { expiration: ExpirationTime.fromHours(72), flags: READ_ONLY },
      ),
    )
  }

  ack(input: {
    recall: Hex
    recallHash: string
    agent: Hex
    artifact: string
    action: AckAction
    issuer: Hex
    newHash?: string
  }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Ack,
        clean({
          recall: key(input.recall),
          recallHash: input.recallHash,
          agent: addr(input.agent),
          artifact: input.artifact.toLowerCase(),
          action: input.action,
          issuer: addr(input.issuer),
          newHash: input.newHash,
        }) as any,
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  lift(input: {
    recall: Hex
    artifact: string
    kind: LiftKind
    fixedHash?: string
    fixedVersion?: string
    fixedRef?: string
    note?: string
  }) {
    assertPublicRef(input.fixedRef)
    return this.enqueue(() =>
      this.wallet.createEntity(
        Lift,
        clean({
          recall: key(input.recall),
          artifact: input.artifact.toLowerCase(),
          kind: input.kind,
          fixedHash: input.fixedHash?.toLowerCase(),
          fixedVersion: input.fixedVersion,
          fixedRef: input.fixedRef,
          note: text(input.note),
        }) as any,
        { expiration: ExpirationTime.max(), flags: READ_ONLY },
      ),
    )
  }

  loadout(input: { seq: bigint; files: LoadedFile[] }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Loadout,
        { agent: addr(this.address), seq: u64(input.seq), files: stringToBytes(JSON.stringify(input.files)) },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  artifact(input: {
    hash: string
    kind: string
    name: string
    version: string
    source?: string
    derivedFrom?: string
  }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Artifact,
        clean({
          hash: input.hash.toLowerCase(),
          kind: input.kind,
          name: input.name,
          version: input.version,
          publisher: addr(this.address),
          source: input.source,
          derivedFrom: input.derivedFrom,
        }) as any,
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  createHeartbeat(input: { mode: AgentStatus; loadoutSeq: bigint; ttlSeconds: number }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Heartbeat,
        { agent: addr(this.address), mode: input.mode, loadoutSeq: u64(input.loadoutSeq) },
        { expiration: ExpirationTime.fromSeconds(input.ttlSeconds) },
      ),
    )
  }

  /** A new status: updates and extends a heartbeat in one transaction. */
  updateHeartbeat(entityKey: Hex, input: { mode: AgentStatus; loadoutSeq: bigint; ttlSeconds: number }) {
    return this.enqueue(() =>
      this.wallet.executeBatch(
        {
          patches: [{ schema: Heartbeat, entityKey, set: { mode: input.mode, loadoutSeq: u64(input.loadoutSeq) } }],
          extensions: [{ entityKey, expiration: ExpirationTime.fromSeconds(input.ttlSeconds) }],
        },
        { gas: HEARTBEAT_PATCH_GAS },
      ),
    )
  }

  /** Nothing has changed: just keeps the heartbeat alive. Arkiv still records the update time. */
  extendHeartbeat(entityKey: Hex, ttlSeconds: number) {
    return this.enqueue(() =>
      this.wallet.extendEntity({ entityKey, expiration: ExpirationTime.fromSeconds(ttlSeconds) }),
    )
  }

  /** One part of an agent's diary: where it lives on 0G Storage and the hash its entries must end on. */
  diary(input: { root: string; head: string; entries: bigint; firstSeq: bigint; lastSeq: bigint }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Diary,
        {
          agent: addr(this.address),
          root: input.root,
          head: input.head,
          entries: u64(input.entries),
          firstSeq: u64(input.firstSeq),
          lastSeq: u64(input.lastSeq),
        },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  disclose(input: { recall: Hex; description: string; reproductionRef?: string }) {
    assertPublicRef(input.reproductionRef)
    return this.enqueue(() =>
      this.wallet.createEntity(
        Disclose,
        clean({
          recall: key(input.recall),
          description: stringToBytes(input.description),
          reproductionRef: input.reproductionRef,
        }) as any,
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  /** Written by the owner, which is what ties an agent to someone responsible. */
  agent(input: { agent: Hex; name: string; framework: string; purpose: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Agent,
        {
          agent: addr(input.agent),
          owner: addr(this.address),
          name: input.name,
          framework: input.framework,
          purpose: stringToBytes(input.purpose),
        },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  /** Publishes whose STOPs this owner's agents obey. The highest number wins. */
  trustList(input: { seq: bigint; policy: TrustPolicy }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        TrustList,
        { owner: addr(this.address), seq: u64(input.seq), policy: stringToBytes(JSON.stringify(input.policy)) },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }
}
