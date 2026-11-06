import { type EndorseRow, hashBytes, type Hex, type HumanRow, isUnverifiedHuman, loginMessage, loginSignal, lower, openRecallMessage, type RecallRow, SIGNED_REQUEST_MS, type Stance, unverifiedHuman, voteMessage } from "@ceasenet/core"
import { hashSignal } from "@worldcoin/idkit-core/hashing"
import { signRequest } from "@worldcoin/idkit-core/signing"
import { recoverMessageAddress } from "viem"

/**
 * What the verifier needs from World ID: proof that this is one unique person.
 *
 * A login asks only "is this a different human?". It does not need a name, an age or a nationality, so Proof of Human
 * is the least that does the job, and anything stronger would ask people for more than it needs.
 */
export const CONFIRM_ACTION = "confirm-warning"
export const CREDENTIAL = "proof_of_human"
/** The same check, as World App answered before World ID 4. */
const LEGACY_CREDENTIALS = ["proof_of_human", "orb"]
const SIGNATURE_TTL_SECONDS = 300
/** A wallet's clock can be a little ahead of this one. */
const CLOCK_SKEW_MS = 60_000

/** There is already an open recall on this target, so the person should vote on it instead. */
export class AlreadyReported extends Error {
  override name = "AlreadyReported"
  constructor(readonly key: Hex) {
    super("Someone has already opened a recall on this. You can vote on theirs.")
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
  /** The normal recall, if it exists and this verifier created it. */
  readWarning(recall: Hex): Promise<RecallRow | undefined>
  readEndorsements(recall: Hex): Promise<EndorseRow[]>
  endorse(input: { recall: Hex; stance: Stance; human: string }): Promise<{ entityKey: Hex; txHash: Hex }>
  /** The verifier's record of who logged in with this address. */
  readHuman(address: Hex): Promise<HumanRow | undefined>
  /** The verifier's record of the address this person logged in with. */
  readHumanById(human: string): Promise<HumanRow | undefined>
  writeHuman(input: { address: Hex; human: string }): Promise<{ entityKey: Hex; txHash: Hex }>
  /** Normal recalls still open about this target. */
  readOpenReports?(artifact: string): Promise<RecallRow[]>
  /** Whether an agent's owner has registered it, since only a registered agent has anyone to approve a recall. */
  agentExists?(address: Hex): Promise<boolean>
  fileReport?(input: { artifact: string; reason: string; pkg?: string; versions?: string; opener: Hex }): Promise<{ entityKey: Hex; txHash: Hex }>
  fetchImpl?: typeof fetch
  now?: () => number
  /**
   * Refuse a World ID result unless this verifier started its request, and only once. True unless turned off: a
   * serverless copy cannot know what another copy started. World still checks our signature on the request and its
   * expiry, and a login needs a fresh signature from the wallet, so a replay can only log the same pair in again.
   */
  trackRequests?: boolean
  /**
   * Let a wallet log in without World ID, for showing the flow when World App cannot be used. Such a login is marked
   * "unverified-" on the record and on every page, and a later World ID login from the same wallet replaces it.
   */
  allowBypass?: boolean
}

/** A request signed by a logged-in wallet. */
export interface Signed {
  address: Hex
  signature: Hex
  /** When it was signed, in milliseconds since 1970. */
  at: number
}

export interface LoginInput extends Signed {
  /** The IDKit result, exactly as it arrived. It is forwarded to World unchanged. */
  result: any
}

export interface VoteInput extends Signed {
  recall: Hex
  stance: Stance
}

/** The value kept for one person. It is the same each time they log in, and says nothing else about them. */
export const humanId = (nullifier: string, scope: string): Hex => hashBytes(`${nullifier}:${lower(scope)}`)

const isHexKey = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)
const isAddress = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)

/** What someone opens a recall on. */
export type ReportTarget = { kind: "agent"; address: string } | { kind: "tool"; name: string; version?: string; hash?: string }

export interface ReportInput extends Signed {
  target: ReportTarget
  reason: string
}

const REASON_MIN = 10
const REASON_MAX = 400
/** Opening writes to the chain at this service's expense, so one person cannot open without limit. */
const REPORTS_PER_HOUR = 5
const HOUR_MS = 3_600_000

/** Turns what someone typed into what a recall names, or says what is wrong with it. */
export function reportArtifact(target: ReportTarget): { artifact: string; pkg?: string; versions?: string } {
  if (target?.kind === "agent") {
    if (typeof target.address !== "string" || !isAddress(target.address)) throw new Refused("bad_target", "That is not an agent's address.")
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

  /**
   * Links one real person to one wallet address. World ID shows a unique human, and the wallet's signature shows the
   * address is theirs. Logging in again with the same pair changes nothing. Nothing from the browser is believed until
   * both have been checked.
   */
  async login(input: LoginInput): Promise<{ key: Hex; address: Hex; human: string; already: boolean }> {
    const address = await this.checkSigned(input, (a, at) => loginMessage(a, at))
    const { nullifier } = this.readProof(input.result, loginSignal(address))
    await this.checkWithWorld(input.result)
    // Used once it has been checked, so a failed attempt can be tried again with the same request.
    this.issued.delete(input.result.nonce)

    const human = humanId(nullifier, "login")
    const [byPerson, byAddress] = await Promise.all([this.options.readHumanById(human), this.options.readHuman(address)])
    if (byPerson && lower(byPerson.address) !== lower(address)) {
      throw new Refused("other_address", `Your World ID is already linked to ${byPerson.address}. One person logs in with one wallet: please use that one.`)
    }
    if (byAddress && byAddress.human !== human && !isUnverifiedHuman(byAddress.human)) {
      throw new Refused("other_person", "This wallet is already linked to another person.")
    }
    if (byPerson) return { key: byPerson.key, address, human, already: true }
    const { entityKey } = await this.options.writeHuman({ address, human })
    return { key: entityKey, address, human, already: false }
  }

  get bypassAllowed(): boolean {
    return Boolean(this.options.allowBypass)
  }

  /** Logs a wallet in with its signature alone, when allowed. It says so on the record: nothing checked a person. */
  async bypassLogin(input: Signed): Promise<{ key: Hex; address: Hex; human: string; already: boolean }> {
    if (!this.options.allowBypass) throw new Refused("not_available", "Logging in without World ID is turned off here.")
    const address = await this.checkSigned(input, (a, at) => loginMessage(a, at))
    const existing = await this.options.readHuman(address)
    if (existing) return { key: existing.key, address, human: existing.human, already: true }
    const human = unverifiedHuman(address)
    const { entityKey } = await this.options.writeHuman({ address, human })
    return { key: entityKey, address, human, already: false }
  }

  /** A logged-in person votes on a normal recall. One vote per person on each, because one person has one address. */
  async confirm(input: VoteInput): Promise<{ key: Hex; txHash: Hex; human: string }> {
    const { recall, stance } = input
    if (!isHexKey(recall)) throw new Refused("bad_request", "That is not a recall key.")
    if (stance !== "CONFIRM" && stance !== "DISPUTE") throw new Refused("bad_request", "Vote for or against.")
    const address = await this.checkSigned(input, (a, at) => voteMessage(recall, stance, at))
    await this.loggedIn(address)

    const warning = await this.options.readWarning(recall)
    if (!warning) throw new Refused("no_such_warning", "There is no such normal recall.")
    // A vote is public, and names the logged-in address that cast it.
    const human = lower(address)
    const earlier = await this.options.readEndorsements(recall)
    if (earlier.some((e) => lower(e.human) === human)) {
      throw new Refused("already_counted", "You have already voted on this recall.")
    }
    const { entityKey, txHash } = await this.options.endorse({ recall, stance, human })
    return { key: entityKey, txHash, human }
  }

  /** A logged-in person opens a normal recall. It counts as their vote. It does nothing until the owner approves it. */
  async report(input: ReportInput): Promise<{ key: Hex; txHash: Hex }> {
    const reason = checkReason(input.reason)
    const named = reportArtifact(input.target)
    const address = await this.checkSigned(input, (_a, at) => openRecallMessage(named.artifact, reason, at))
    const person = await this.loggedIn(address)
    await this.checkTarget(input.target, named)

    const recent = (this.filings.get(person.human) ?? []).filter((at) => this.now() - at < HOUR_MS)
    if (recent.length >= REPORTS_PER_HOUR) throw new Refused("too_many_reports", "You have opened several recalls recently. Please try again later.")
    this.filings.set(person.human, [...recent, this.now()])

    if (!this.options.fileReport) throw new Refused("not_available", "This verifier does not open recalls.")
    const { entityKey, txHash } = await this.options.fileReport({ ...named, reason, opener: address })
    await this.options.endorse({ recall: entityKey, stance: "CONFIRM", human: lower(address) })
    return { key: entityKey, txHash }
  }

  /** The address that signed this message, if it is the one named, and the signature is fresh. */
  private async checkSigned(input: Signed, message: (address: Hex, at: number) => string): Promise<Hex> {
    if (!input || typeof input !== "object") throw new Refused("bad_request", "This request is empty.")
    const { address, signature, at } = input
    if (!isAddress(address)) throw new Refused("bad_request", "That is not a wallet address.")
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Refused("not_signed", "Your wallet has not signed this.")
    if (typeof at !== "number" || !Number.isFinite(at)) throw new Refused("bad_request", "This request has no time on it.")
    const age = this.now() - at
    if (age > SIGNED_REQUEST_MS || age < -CLOCK_SKEW_MS) throw new Refused("stale_request", "This signature is too old. Please try again.")
    let signer: Hex
    try {
      signer = await recoverMessageAddress({ message: message(address, at), signature })
    } catch {
      throw new Refused("bad_signature", "That signature cannot be read.")
    }
    if (lower(signer) !== lower(address)) throw new Refused("bad_signature", "That signature is not from this wallet.")
    return lower(address) as Hex
  }

  private async loggedIn(address: Hex): Promise<HumanRow> {
    const person = await this.options.readHuman(address)
    if (!person) throw new Refused("not_logged_in", "Log in with World first. It shows you are a real person.")
    return person
  }

  /** Everything about a proof that can be checked before asking World. Nothing from the browser is believed yet. */
  private readProof(result: any, signal: string): { nullifier: string } {
    if (!result || typeof result !== "object") throw new Refused("bad_request", "There is no World ID result in this request.")
    this.forgetExpired()
    if (this.options.trackRequests !== false && !this.issued.has(result.nonce)) {
      throw new Refused("stale_request", "This verification has expired or was already used. Please try again.")
    }
    if (result.environment !== this.options.environment) {
      throw new Refused("wrong_environment", `This verifier accepts ${this.options.environment} proofs only.`)
    }
    if (result.action !== CONFIRM_ACTION) throw new Refused("wrong_action", "This proof was made for something else.")

    const response = Array.isArray(result.responses) ? result.responses[0] : undefined
    if (!response) throw new Refused("no_proof", "This result has no proof in it.")
    // An older World App answers in the legacy format, where an Orb-verified person can be named "orb".
    if (response.identifier !== CREDENTIAL && !(result.protocol_version === "3.0" && LEGACY_CREDENTIALS.includes(response.identifier))) {
      throw new Refused("wrong_credential", "Logging in needs Proof of Human.")
    }
    if (String(response.signal_hash).toLowerCase() !== hashSignal(signal).toLowerCase()) {
      throw new Refused("wrong_signal", "This proof was made for a different wallet.")
    }
    if (typeof response.nullifier !== "string" || response.nullifier === "") {
      throw new Refused("no_proof", "This result has no proof in it.")
    }
    return { nullifier: response.nullifier }
  }

  private async checkTarget(target: ReportTarget, named: { artifact: string }): Promise<void> {
    if (target.kind === "agent" && this.options.agentExists && !(await this.options.agentExists(target.address as Hex))) {
      throw new Refused("no_such_agent", "No owner has registered that agent, so there is nobody to approve a recall.")
    }
    const open = await this.options.readOpenReports?.(named.artifact)
    if (open?.length) throw new AlreadyReported(open[0]!.key)
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
      throw new Refused("world_unreachable", "World ID could not be reached, so you are not logged in. Please try again.")
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
