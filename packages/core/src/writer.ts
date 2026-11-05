import { ExpirationTime } from "@arkiv-network/sdk"
import { addr, key, u64 } from "@arkiv-network/sdk/schema"
import { stringToBytes } from "viem"
import type { ArkivWallet } from "./arkiv"
import { recallContentHash } from "./hash"
import { Ack, Agent, Artifact, Custody, Disclose, Endorse, Episode, Heartbeat, Lift, Loadout, Recall, Robot, TrustList } from "./schema"
import type { AckAction, Hex, LiftKind, LoadedFile, Mode, Stance } from "./types"

const READ_ONLY = { readonly: true } as const
/** Nobody can edit a STOP, and anyone can keep it alive, so it cannot quietly lapse. */
const STOP_FLAGS = { readonly: true, permissionlessExtension: true } as const
const LONG = () => ExpirationTime.fromDays(180)

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
    const run = this.queue.then(task, task)
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
    robot: Hex
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
          robot: addr(input.robot),
          artifact: input.artifact.toLowerCase(),
          action: input.action,
          issuer: addr(input.issuer),
          newHash: input.newHash,
        }) as any,
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  lift(input: { recall: Hex; artifact: string; kind: LiftKind; fixedHash?: string; fixedRef?: string; note?: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Lift,
        clean({
          recall: key(input.recall),
          artifact: input.artifact.toLowerCase(),
          kind: input.kind,
          fixedHash: input.fixedHash?.toLowerCase(),
          fixedRef: input.fixedRef,
          note: text(input.note),
        }) as any,
        { expiration: ExpirationTime.max(), flags: READ_ONLY },
      ),
    )
  }

  robot(input: { robot: Hex; model: string; serial: string; city: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Robot,
        { robot: addr(input.robot), maker: addr(this.address), model: input.model, serial: input.serial, city: input.city },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  loadout(input: { seq: bigint; files: LoadedFile[] }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Loadout,
        { robot: addr(this.address), seq: u64(input.seq), files: stringToBytes(JSON.stringify(input.files)) },
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

  createHeartbeat(input: { mode: Mode | "PAUSED"; loadoutSeq: bigint; ttlSeconds: number }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Heartbeat,
        { robot: addr(this.address), mode: input.mode, loadoutSeq: u64(input.loadoutSeq) },
        { expiration: ExpirationTime.fromSeconds(input.ttlSeconds) },
      ),
    )
  }

  /** Updates and extends a heartbeat in one transaction. */
  updateHeartbeat(entityKey: Hex, input: { mode: Mode | "PAUSED"; loadoutSeq: bigint; ttlSeconds: number }) {
    return this.enqueue(() =>
      this.wallet.executeBatch({
        patches: [{ schema: Heartbeat, entityKey, set: { mode: input.mode, loadoutSeq: u64(input.loadoutSeq) } }],
        extensions: [{ entityKey, expiration: ExpirationTime.fromSeconds(input.ttlSeconds) }],
      }),
    )
  }

  /** Created by the maker, then handed to the operator: `$creator` proves who issued it, `$owner` who holds it now. */
  custody(input: { robot: Hex; operator: string; contact: string; insurance?: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Custody,
        clean({
          robot: addr(input.robot),
          operator: input.operator,
          contact: input.contact,
          insurance: input.insurance,
        }) as any,
        { expiration: LONG() },
      ),
    )
  }

  transfer(entityKey: Hex, newOwner: Hex) {
    return this.enqueue(() => this.wallet.changeOwnership({ entityKey, newOwner }))
  }

  updateCustody(entityKey: Hex, input: { operator: string; contact: string }) {
    return this.enqueue(() =>
      this.wallet.patchEntity(Custody, entityKey, { set: { operator: input.operator, contact: input.contact } }),
    )
  }

  episode(input: {
    softwareHash: string
    root: string
    decisions: bigint
    firstRequestId: string
    lastRequestId: string
  }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Episode,
        {
          robot: addr(this.address),
          softwareHash: input.softwareHash.toLowerCase(),
          root: input.root,
          decisions: u64(input.decisions),
          firstRequestId: input.firstRequestId,
          lastRequestId: input.lastRequestId,
        },
        { expiration: ExpirationTime.fromDays(30), flags: READ_ONLY },
      ),
    )
  }

  disclose(input: { recall: Hex; description: string; reproductionRef?: string }) {
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

  agent(input: { owner: Hex; framework: string; purpose: string }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        Agent,
        { agent: addr(this.address), owner: addr(input.owner), framework: input.framework, purpose: stringToBytes(input.purpose) },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }

  trustList(input: { seq: bigint; issuers: string[] }) {
    return this.enqueue(() =>
      this.wallet.createEntity(
        TrustList,
        { owner: addr(this.address), seq: u64(input.seq), issuers: stringToBytes(JSON.stringify(input.issuers)) },
        { expiration: LONG(), flags: READ_ONLY },
      ),
    )
  }
}
