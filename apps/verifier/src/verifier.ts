import { confirmationSignal, type EndorseRow, hashBytes, type Hex, lower, type RecallRow, reportSignal, type Stance } from "@ceasenet/core"
import { hashSignal } from "@worldcoin/idkit-core/hashing"
import { signRequest } from "@worldcoin/idkit-core/signing"

/**
 * What the verifier needs from World ID: proof that this is one unique person.
 *
 * A confirmation asks only "is this a different human?". It does not need a name, an age or a nationality, so
 * Proof of Human is the least that does the job, and anything stronger would ask people for more than it needs.
 */
export const CONFIRM_ACTION = "confirm-warning"
export const CREDENTIAL = "proof_of_human"
const SIGNATURE_TTL_SECONDS = 300

/** There is already an open report on this target, so the person should vote on it instead. */
export class AlreadyReported extends Error {
  override name = "AlreadyReported"
  constructor(readonly key: Hex) {
    super("Someone has already reported this. You can vote on their report.")
  }
}

/** A request the verifier turned down. The message is safe to show the person. */
export class Refused extends Error {
  override name = "Refused"
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export type WorldEnvironment = "production" | "staging" | "sandbox"

export interface VerifierOptions {
  rpId: string
  signingKey: string
  environment: WorldEnvironment
  /** The warning, if it exists and this verifier created it. */
  readWarning(recall: Hex): Promise<RecallRow | undefined>
  readEndorsements(recall: Hex): Promise<EndorseRow[]>
  endorse(input: { recall: Hex; stance: Stance; human: string }): Promise<{ entityKey: Hex; txHash: Hex }>
  /** Reports still open about this target. */
  readOpenReports?(artifact: string): Promise<RecallRow[]>
  /** Whether an agent's owner has registered it, since only a registered agent has anyone to tell. */
  agentExists?(address: Hex): Promise<boolean>
  fileReport?(input: { artifact: string; reason: string; pkg?: string; versions?: string }): Promise<{ entityKey: Hex; txHash: Hex }>
  /** Only outside production, and it says so on the record: for showing the flow with one test identity. */
  allowSimulated?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ConfirmInput {
  recall: Hex
  stance: Stance
  /** The IDKit result, exactly as it arrived. It is forwarded to World unchanged. */
  result: any
}

/**
 * The value kept on Arkiv for a person. It is the same for one person on one warning, which stops double
 * counting, and different across warnings, so nobody can follow one person from warning to warning.
 */
export const humanId = (nullifier: string, recall: string): Hex => hashBytes(`${nullifier}:${lower(recall)}`)

const isHexKey = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)

/** What someone is reporting. */
export type ReportTarget = { kind: "agent"; address: string } | { kind: "tool"; name: string; version?: string; hash?: string }

export interface ReportInput {
  target: ReportTarget
  reason: string
  result: any
}

const REASON_MIN = 10
const REASON_MAX = 400
/** Filing writes to the chain at this service's expense, so one person cannot file without limit. */
const REPORTS_PER_HOUR = 5
const HOUR_MS = 3_600_000

/** Turns what someone typed into what a report names, or says what is wrong with it. */
export function reportArtifact(target: ReportTarget): { artifact: string; pkg?: string; versions?: string } {
  if (target?.kind === "agent") {
    if (typeof target.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(target.address)) throw new Refused("bad_target", "That is not an agent's address.")
    return { artifact: `agent:${target.address.toLowerCase()}` }
  }
  if (target?.kind === "tool") {
    const name = typeof target.name === "string" ? target.name.trim() : ""
    if (!name || name.length > 100) throw new Refused("bad_target", "Say which tool: its package name.")
    if (target.hash !== undefined && !/^0x[0-9a-fA-F]{1,64}$/.test(target.hash)) throw new Refused("bad_target", "That is not a file hash.")
    return { artifact: (target.hash ?? `package:${name}`).toLowerCase(), pkg: name, versions: target.version?.trim() || "*" }
  }
  throw new Refused("bad_target", "Say whether this is about an agent or a tool.")
}

const checkReason = (reason: unknown): string => {
  const text = typeof reason === "string" ? reason.trim() : ""
  if (text.length < REASON_MIN) throw new Refused("bad_reason", "Say what is wrong, in a sentence. People will vote on this.")
  if (text.length > REASON_MAX) throw new Refused("bad_reason", `Keep it under ${REASON_MAX} characters.`)
  return text
}

export class Verifier {
  private readonly issued = new Map<string, number>()
  private readonly filings = new Map<string, number[]>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: VerifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** Signs the start of one request. This must happen here: the key never reaches a browser. */
  rpSignature(): { sig: string; nonce: string; created_at: number; expires_at: number } {
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: this.options.signingKey,
      action: CONFIRM_ACTION,
      ttl: SIGNATURE_TTL_SECONDS,
    })
    this.forgetExpired()
    this.issued.set(nonce, this.now() + SIGNATURE_TTL_SECONDS * 1000)
    return { sig, nonce, created_at: createdAt, expires_at: expiresAt }
  }

  private forgetExpired(): void {
    const now = this.now()
    for (const [nonce, until] of this.issued) if (until < now) this.issued.delete(nonce)
  }

  /** Nothing from the browser is believed until World has checked it here. */
  async confirm(input: ConfirmInput): Promise<{ key: Hex; txHash: Hex; human: Hex }> {
    const { recall, stance, result } = input
    if (!isHexKey(recall)) throw new Refused("bad_request", "That is not a warning key.")
    if (stance !== "CONFIRM" && stance !== "DISPUTE") throw new Refused("bad_request", "Choose confirm or dispute.")
    const response = this.readProof(result, confirmationSignal(recall, stance))

    const warning = await this.options.readWarning(recall)
    if (!warning) throw new Refused("no_such_warning", "There is no such warning.")

    await this.checkWithWorld(result)
    // Used once it has been checked, so a failed attempt can be tried again with the same request.
    this.issued.delete(result.nonce)

    const human = humanId(response.nullifier, recall)
    const earlier = await this.options.readEndorsements(recall)
    if (earlier.some((e) => e.human === human)) {
      throw new Refused("already_counted", "You have already given your answer on this warning.")
    }
    const { entityKey, txHash } = await this.options.endorse({ recall, stance, human })
    return { key: entityKey, txHash, human }
  }

  /** Everything about a proof that can be checked before asking World. Nothing from the browser is believed yet. */
  private readProof(result: any, signal: string): { nullifier: string } {
    if (!result || typeof result !== "object") throw new Refused("bad_request", "There is no World ID result in this request.")
    this.forgetExpired()
    if (!this.issued.has(result.nonce)) {
      throw new Refused("stale_request", "This verification has expired or was already used. Please try again.")
    }
    if (result.environment !== this.options.environment) {
      throw new Refused("wrong_environment", `This verifier accepts ${this.options.environment} proofs only.`)
    }
    if (result.action !== CONFIRM_ACTION) throw new Refused("wrong_action", "This proof was made for something else.")

    const response = Array.isArray(result.responses) ? result.responses[0] : undefined
    if (!response) throw new Refused("no_proof", "This result has no proof in it.")
    if (response.identifier !== CREDENTIAL) {
      throw new Refused("wrong_credential", "A confirmation needs Proof of Human.")
    }
    if (String(response.signal_hash).toLowerCase() !== hashSignal(signal).toLowerCase()) {
      throw new Refused("wrong_signal", "This proof was made for a different warning.")
    }
    if (typeof response.nullifier !== "string" || response.nullifier === "") {
      throw new Refused("no_proof", "This result has no proof in it.")
    }
    return { nullifier: response.nullifier }
  }

  private async checkTarget(target: ReportTarget): Promise<{ artifact: string; pkg?: string; versions?: string }> {
    const named = reportArtifact(target)
    if (target.kind === "agent" && this.options.agentExists && !(await this.options.agentExists(target.address as Hex))) {
      throw new Refused("no_such_agent", "No owner has registered that agent, so there is nobody to tell.")
    }
    const open = await this.options.readOpenReports?.(named.artifact)
    if (open?.length) throw new AlreadyReported(open[0]!.key)
    return named
  }

  /**
   * A real person reports an agent or a tool. It counts as their vote, and because the same action is used for both,
   * World gives them the same nullifier: voting on their own report afterwards is refused as a second answer.
   */
  async report(input: ReportInput): Promise<{ key: Hex; txHash: Hex }> {
    const reason = checkReason(input.reason)
    const named = reportArtifact(input.target)
    const { nullifier } = this.readProof(input.result, reportSignal(named.artifact, reason))
    await this.checkTarget(input.target)
    await this.checkWithWorld(input.result)
    this.issued.delete(input.result.nonce)

    const limitBy = hashBytes(nullifier)
    const recent = (this.filings.get(limitBy) ?? []).filter((at) => this.now() - at < HOUR_MS)
    if (recent.length >= REPORTS_PER_HOUR) throw new Refused("too_many_reports", "You have filed several reports recently. Please try again later.")
    this.filings.set(limitBy, [...recent, this.now()])

    return this.file(named, reason, (key) => humanId(nullifier, key))
  }

  private async file(named: { artifact: string; pkg?: string; versions?: string }, reason: string, human: (key: Hex) => string): Promise<{ key: Hex; txHash: Hex }> {
    if (!this.options.fileReport) throw new Refused("not_available", "This verifier does not take reports.")
    const { entityKey, txHash } = await this.options.fileReport({ ...named, reason })
    await this.options.endorse({ recall: entityKey, stance: "CONFIRM", human: human(entityKey) })
    return { key: entityKey, txHash }
  }

  /** A stand-in for a person, for showing the flow where World's simulator can only ever be one identity. */
  private assertSimulated(): void {
    if (!this.options.allowSimulated || this.options.environment === "production") throw new Refused("not_available", "Simulated people are not allowed here.")
  }

  get simulatedAllowed(): boolean {
    return Boolean(this.options.allowSimulated) && this.options.environment !== "production"
  }

  async simulatedReport(input: Omit<ReportInput, "result">): Promise<{ key: Hex; txHash: Hex }> {
    this.assertSimulated()
    const reason = checkReason(input.reason)
    const named = await this.checkTarget(input.target)
    return this.file(named, reason, () => `simulated-${hashBytes(`${this.now()}:${Math.random()}`).slice(2, 14)}`)
  }

  /** On the record as simulated, so nobody can mistake it for a real person. */
  async simulatedVote(recall: Hex, stance: Stance = "CONFIRM"): Promise<{ key: Hex; human: string }> {
    this.assertSimulated()
    if (!isHexKey(recall)) throw new Refused("bad_request", "That is not a warning key.")
    if (!(await this.options.readWarning(recall))) throw new Refused("no_such_warning", "There is no such warning.")
    const human = `simulated-${hashBytes(`${this.now()}:${Math.random()}`).slice(2, 14)}`
    const { entityKey } = await this.options.endorse({ recall, stance, human })
    return { key: entityKey, human }
  }

  /** Forwards the proof unchanged, and accepts only a clear yes for the expected environment. */
  private async checkWithWorld(result: unknown): Promise<void> {
    const { rpId, environment } = this.options
    let res: Response
    try {
      res = await this.fetchImpl(`https://developer.world.org/api/v4/verify/${rpId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(result as object), environment }),
      })
    } catch {
      throw new Refused("world_unreachable", "World ID could not be reached, so nothing was counted. Please try again.")
    }
    const body = (await res.json().catch(() => undefined)) as
      | { success?: boolean; environment?: string; code?: string; detail?: string }
      | undefined
    if (!res.ok || body?.success !== true) {
      throw new Refused(body?.code ?? "world_rejected", body?.detail ?? "World ID did not accept this proof.")
    }
    if (body.environment !== undefined && body.environment !== environment) {
      throw new Refused("wrong_environment", `This verifier accepts ${environment} proofs only.`)
    }
  }
}
