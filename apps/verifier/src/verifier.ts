import { confirmationSignal, type EndorseRow, hashBytes, type Hex, lower, type RecallRow, type Stance } from "@ceasenet/core"
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

export class Verifier {
  private readonly issued = new Map<string, number>()
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
    if (String(response.signal_hash).toLowerCase() !== hashSignal(confirmationSignal(recall, stance)).toLowerCase()) {
      throw new Refused("wrong_signal", "This proof was made for a different warning.")
    }
    if (typeof response.nullifier !== "string" || response.nullifier === "") {
      throw new Refused("no_proof", "This result has no proof in it.")
    }

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
