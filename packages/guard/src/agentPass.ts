import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createRemoteJWKSet, jwtVerify } from "jose"
import type { Approver } from "./guard"

/** A person verified at an Orb. Enough to say a real human answered, and that this human cannot be many people. */
export const ORB_CLASS = "https://world.org/oidc/acr/orb"
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
/** Clocks differ a little. World allows 30 seconds, and so does this. */
const CLOCK_TOLERANCE_S = 30
const REQUEST_TIMEOUT_MS = 15_000
const SLOW_DOWN_S = 5

export interface AgentPassOptions {
  /** https://auth.world.org, or the sandbox. Credentials only work with the issuer they came from. */
  issuer: string
  clientId: string
  /** Stays in this backend. It never reaches a browser, a model or a tool. */
  clientSecret: string
  /** How this client was registered. The portal's default is basic. */
  authMethod?: "client_secret_basic" | "client_secret_post"
  /** The class of person accepted. */
  acr?: string
  fetch?: typeof fetch
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

export type PassFailure = "denied" | "expired" | "cancelled" | "invalid" | "unavailable"

export type PassResult =
  | { ok: true; issuer: string; subject: string; acr: string; amr: string[]; authTime: number }
  | { ok: false; reason: PassFailure; message: string }

/** Safe to show a person. The device code itself stays in here. */
export interface PassAttempt {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  /** Never rejects. Anything other than a validated person comes back as `ok: false`. */
  result: Promise<PassResult>
  cancel(): void
}

interface Discovery {
  issuer: string
  device_authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

const encodeCredential = (value: string) => encodeURIComponent(value).replace(/%20/g, "+")

/**
 * World ID Agent Pass as a human checkpoint: an agent's call stays paused until a real person has approved it
 * from their World ID app, and this backend has validated the signed result.
 *
 * Uses the Device Authorization Grant, because the agent has no browser to redirect. World always requires fresh
 * authentication on this grant, and its tokens carry no nonce, so freshness is checked from the attempt's start.
 */
export class AgentPass {
  private readonly issuer: string
  private readonly doFetch: typeof fetch
  private readonly now: () => number
  private readonly wait: (ms: number) => Promise<void>
  private readonly acr: string
  private discovery: Promise<Discovery> | undefined
  private keys: ReturnType<typeof createRemoteJWKSet> | undefined

  constructor(readonly opts: AgentPassOptions) {
    this.issuer = opts.issuer.replace(/\/+$/, "")
    this.doFetch = opts.fetch ?? fetch
    this.now = opts.now ?? Date.now
    this.wait = opts.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.acr = opts.acr ?? ORB_CLASS
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await this.doFetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`World ID discovery failed: HTTP ${res.status}`)
      const doc = (await res.json()) as Discovery
      if (doc.issuer !== this.issuer) throw new Error("World ID discovery names a different issuer")
      return doc
    })().catch((e) => {
      this.discovery = undefined
      throw e
    })
    return this.discovery
  }

  /** Sends the client's credentials the way it was registered. */
  private post(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const { clientId, clientSecret, authMethod = "client_secret_basic" } = this.opts
    const body = new URLSearchParams(fields)
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
    if (authMethod === "client_secret_post") {
      body.set("client_id", clientId)
      body.set("client_secret", clientSecret)
    } else {
      headers.authorization = `Basic ${btoa(`${encodeCredential(clientId)}:${encodeCredential(clientSecret)}`)}`
    }
    return this.doFetch(url, { method: "POST", headers, body, signal })
  }

  /** Starts one attempt. A failed attempt is never restarted automatically. */
  async start(): Promise<PassAttempt> {
    const discovery = await this.discover()
    const startedAt = this.now()
    const res = await this.post(
      discovery.device_authorization_endpoint,
      { scope: "openid", claims: JSON.stringify({ id_token: { acr: { essential: true, values: [this.acr] } } }) },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(`World ID refused to start: ${String(json.error ?? `HTTP ${res.status}`)}`)

    const expiresIn = Number(json.expires_in)
    const interval = Number(json.interval)
    const deviceCode = json.device_code
    if (typeof deviceCode !== "string" || typeof json.user_code !== "string" || typeof json.verification_uri !== "string" || !(expiresIn > 0)) {
      throw new Error("World ID sent an incomplete answer")
    }

    const stop = new AbortController()
    const expiresAt = startedAt + expiresIn * 1000
    return {
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      verificationUriComplete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
      expiresAt,
      result: this.poll(discovery, deviceCode, interval > 0 ? interval : SLOW_DOWN_S, startedAt, expiresAt, stop.signal),
      cancel: () => stop.abort(),
    }
  }

  /** Follows World's stop rules: only a validated token can come out as approval. */
  private async poll(
    discovery: Discovery,
    deviceCode: string,
    firstInterval: number,
    startedAt: number,
    expiresAt: number,
    cancelled: AbortSignal,
  ): Promise<PassResult> {
    const failed = (reason: PassFailure, message: string): PassResult => ({ ok: false, reason, message })
    let interval = firstInterval
    for (;;) {
      await this.waitOrCancel(interval * 1000, cancelled)
      if (cancelled.aborted) return failed("cancelled", "The request was cancelled.")
      const remaining = expiresAt - this.now()
      if (remaining <= 0) return failed("expired", "The request expired before anyone approved it.")

      let res: Response
      try {
        res = await this.post(
          discovery.token_endpoint,
          { grant_type: DEVICE_GRANT, device_code: deviceCode },
          AbortSignal.any([cancelled, AbortSignal.timeout(Math.min(remaining, REQUEST_TIMEOUT_MS))]),
        )
      } catch {
        if (cancelled.aborted) return failed("cancelled", "The request was cancelled.")
        // A timeout tells us nothing. Back off, and the expiry check above ends it eventually.
        interval += SLOW_DOWN_S
        continue
      }

      if (res.status === 503 || res.status === 429) return failed("unavailable", `World ID is unavailable right now (HTTP ${res.status}).`)
      const json = (await res.json().catch(() => ({}))) as { error?: string; id_token?: string }
      if (res.ok) {
        if (cancelled.aborted) return failed("cancelled", "The request was cancelled.")
        return json.id_token ? this.validate(discovery, json.id_token, startedAt) : failed("invalid", "World ID sent no ID token.")
      }
      if (json.error === "authorization_pending") continue
      if (json.error === "slow_down") {
        interval += SLOW_DOWN_S
        continue
      }
      if (json.error === "access_denied") return failed("denied", "The person refused, or does not meet the requirement.")
      if (json.error === "expired_token") return failed("expired", "The request expired before anyone approved it.")
      return failed("invalid", `World ID ended the attempt: ${json.error ?? `HTTP ${res.status}`}`)
    }
  }

  private waitOrCancel(ms: number, cancelled: AbortSignal): Promise<void> {
    if (cancelled.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => resolve()
      void this.wait(ms).then(done)
      cancelled.addEventListener("abort", done, { once: true })
    })
  }

  /** Nothing in a token counts until its signature, issuer, audience, class and freshness have all been checked. */
  private async validate(discovery: Discovery, idToken: string, startedAt: number): Promise<PassResult> {
    this.keys ??= createRemoteJWKSet(new URL(discovery.jwks_uri))
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        issuer: this.issuer,
        audience: this.opts.clientId,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: new Date(this.now()),
        requiredClaims: ["sub", "exp", "iat", "auth_time", "acr", "amr"],
      })
      const authTime = Number(payload.auth_time)
      const nowS = this.now() / 1000
      if (!(authTime >= startedAt / 1000 - CLOCK_TOLERANCE_S) || authTime > nowS + CLOCK_TOLERANCE_S) {
        return { ok: false, reason: "invalid", message: "That approval did not happen during this request." }
      }
      if (payload.acr !== this.acr) return { ok: false, reason: "invalid", message: "That account does not meet the requirement." }
      const amr = payload.amr
      if (!Array.isArray(amr) || amr.length === 0) return { ok: false, reason: "invalid", message: "World ID did not say how the person signed in." }
      return { ok: true, issuer: this.issuer, subject: String(payload.sub), acr: String(payload.acr), amr: amr.map(String), authTime }
    } catch (e) {
      return { ok: false, reason: "invalid", message: `The ID token did not validate: ${(e as Error).message.split("\n")[0]}` }
    }
  }
}

/** The configured Agent Pass, or nothing. Half a configuration is refused, because it would fail in the middle of a demo. */
export function agentPassFromEnv(env: NodeJS.ProcessEnv = process.env): AgentPass | undefined {
  const clientId = env.WORLD_IDP_CLIENT_ID
  const clientSecret = env.WORLD_IDP_CLIENT_SECRET
  if (!clientId && !clientSecret) return undefined
  if (!clientId || !clientSecret) throw new Error("Agent Pass needs both WORLD_IDP_CLIENT_ID and WORLD_IDP_CLIENT_SECRET")
  const authMethod = env.WORLD_IDP_AUTH_METHOD === "client_secret_post" ? "client_secret_post" : "client_secret_basic"
  return new AgentPass({ issuer: env.WORLD_IDP_ISSUER || "https://auth.world.org", clientId, clientSecret, authMethod })
}

/** Who may approve for each account. Only this backend sees it: a subject identifies a person to this app. */
export interface ApproverLinks {
  get(account: string): { issuer: string; subject: string } | undefined
  set(account: string, identity: { issuer: string; subject: string }): void
}

export function fileLinks(path: string): ApproverLinks {
  const read = (): Record<string, { issuer: string; subject: string }> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {})
  return {
    get: (account) => read()[account.toLowerCase()],
    set: (account, identity) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ ...read(), [account.toLowerCase()]: identity }, null, 2))
    },
  }
}

/** The first validated person for an account becomes its approver. After that, only they can approve. */
export function matchesLink(links: ApproverLinks, account: string, person: Extract<PassResult, { ok: true }>): boolean {
  const linked = links.get(account)
  if (!linked) {
    links.set(account, { issuer: person.issuer, subject: person.subject })
    return true
  }
  return linked.issuer === person.issuer && linked.subject === person.subject
}

/** For the proxy, which has no page: it prints where to approve, and waits. */
export const approverFromPass =
  (pass: AgentPass, links: ApproverLinks, account: string, log: (line: string) => void): Approver =>
  async (request, signal) => {
    let attempt: PassAttempt
    try {
      attempt = await pass.start()
    } catch (e) {
      log(`could not ask World ID: ${(e as Error).message.split("\n")[0]}`)
      return "EXPIRED"
    }
    log(`${request.action} on ${request.file.name} ${request.file.version} needs a human. Open ${attempt.verificationUriComplete ?? attempt.verificationUri} and enter ${attempt.userCode}`)
    const cancel = () => attempt.cancel()
    signal.addEventListener("abort", cancel, { once: true })
    const result = await attempt.result
    signal.removeEventListener("abort", cancel)
    if (!result.ok) {
      log(result.message)
      return result.reason === "denied" ? "DENIED" : "EXPIRED"
    }
    if (!matchesLink(links, account, result)) {
      log("A different person answered from the one linked to this owner.")
      return "DENIED"
    }
    return "APPROVED"
  }
