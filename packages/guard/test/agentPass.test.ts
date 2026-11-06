import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { AgentPass, agentPassFromEnv, ORB_CLASS } from "../src/agentPass"

const CLIENT = "client-1"
const SECRET = "worldidp_client_secret_abc def"
const DEVICE_CODE = "private-device-code"

type TokenReply = { status: number; body: Record<string, unknown> }

let issuer: string
let server: Server
let sign: (claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; key?: "other"; alg?: string }) => Promise<string>
let replies: (TokenReply | (() => Promise<TokenReply>))[] = []
let startRequests: { auth?: string; form: URLSearchParams }[] = []
let tokenRequests: { auth?: string; form: URLSearchParams }[] = []
let startReply: TokenReply | undefined

const read = async (req: AsyncIterable<unknown>) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

beforeAll(async () => {
  const main = await generateKeyPair("RS256")
  const other = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(main.publicKey)), kid: "k1", alg: "RS256", use: "sig" }
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience ?? CLIENT)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(opts.key === "other" ? other.privateKey : main.privateKey)

  server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.url === "/.well-known/openid-configuration") {
      return json(200, {
        issuer,
        device_authorization_endpoint: `${issuer}/device`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      })
    }
    if (req.url === "/jwks") return json(200, { keys: [jwk] })
    const form = new URLSearchParams(await read(req))
    if (req.url === "/device") {
      startRequests.push({ auth: req.headers.authorization, form })
      const reply = startReply ?? {
        status: 200,
        body: {
          device_code: DEVICE_CODE,
          user_code: "ABCD-EFGH",
          verification_uri: `${issuer}/verify`,
          verification_uri_complete: `${issuer}/verify?code=ABCD-EFGH`,
          expires_in: 1200,
          interval: 5,
        },
      }
      return json(reply.status, reply.body)
    }
    if (req.url === "/token") {
      tokenRequests.push({ auth: req.headers.authorization, form })
      const next = replies.shift()
      const reply = typeof next === "function" ? await next() : next
      return json(reply?.status ?? 400, reply?.body ?? { error: "authorization_pending" })
    }
    return json(404, {})
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  replies = []
  startRequests = []
  tokenRequests = []
  startReply = undefined
})

/** A pass whose clock moves only when it waits, so timing is exact and tests do not sleep. */
function makePass(extra: Partial<ConstructorParameters<typeof AgentPass>[0]> = {}) {
  let clock = Date.now()
  const waits: number[] = []
  const pass = new AgentPass({
    issuer,
    clientId: CLIENT,
    clientSecret: SECRET,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    ...extra,
  })
  return { pass, waits, advance: (ms: number) => (clock += ms), time: () => clock }
}

const nowS = () => Math.floor(Date.now() / 1000)
const goodClaims = () => ({ sub: "person-1", auth_time: nowS() + 5, acr: ORB_CLASS, amr: ["pop"] })
const withToken = async (claims: Record<string, unknown>, opts?: Parameters<typeof sign>[1]): Promise<TokenReply> => ({
  status: 200,
  body: { id_token: await sign(claims, opts), access_token: "opaque", token_type: "Bearer", expires_in: 300 },
})

describe("starting", () => {
  it("asks for a fresh Orb-class person, and sends credentials the way the portal registers them", async () => {
    replies = [await withToken(goodClaims())]
    const attempt = await makePass().pass.start()
    await attempt.result
    const start = startRequests[0]!
    expect(start.form.get("scope")).toBe("openid")
    expect(JSON.parse(start.form.get("claims")!)).toEqual({ id_token: { acr: { essential: true, values: [ORB_CLASS] } } })
    expect(start.form.get("client_secret")).toBeNull()
    expect(start.auth).toBe(`Basic ${btoa(`${CLIENT}:worldidp_client_secret_abc+def`)}`)
  })

  it("can send credentials in the form instead", async () => {
    replies = [await withToken(goodClaims())]
    await (await makePass({ authMethod: "client_secret_post" }).pass.start()).result
    expect(startRequests[0]!.auth).toBeUndefined()
    expect(startRequests[0]!.form.get("client_secret")).toBe(SECRET)
    expect(tokenRequests[0]!.form.get("client_id")).toBe(CLIENT)
    expect(tokenRequests[0]!.form.get("device_code")).toBe(DEVICE_CODE)
  })

  it("shows the person a code and link, and keeps the device code private", async () => {
    replies = [await withToken(goodClaims())]
    const attempt = await makePass().pass.start()
    expect(attempt.userCode).toBe("ABCD-EFGH")
    expect(attempt.verificationUriComplete).toContain("ABCD-EFGH")
    expect(JSON.stringify(attempt)).not.toContain(DEVICE_CODE)
    await attempt.result
  })

  it("reports a refusal to start, and an incomplete answer", async () => {
    startReply = { status: 401, body: { error: "invalid_client" } }
    await expect(makePass().pass.start()).rejects.toThrow("invalid_client")
    startReply = { status: 200, body: { user_code: "X" } }
    await expect(makePass().pass.start()).rejects.toThrow("incomplete")
  })

  it("refuses a discovery document that names another issuer", async () => {
    const lying = new AgentPass({
      issuer: "https://auth.world.org",
      clientId: CLIENT,
      clientSecret: SECRET,
      fetch: (async () => new Response(JSON.stringify({ issuer: "https://evil.example" }))) as typeof fetch,
    })
    await expect(lying.start()).rejects.toThrow("different issuer")
  })
})

describe("waiting", () => {
  it("polls with the device grant until the person approves", async () => {
    replies = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "authorization_pending" } },
      await withToken(goodClaims()),
    ]
    const { pass, waits } = makePass()
    const result = await (await pass.start()).result
    expect(result).toMatchObject({ ok: true, subject: "person-1", acr: ORB_CLASS, amr: ["pop"], issuer })
    expect(waits).toEqual([5000, 5000, 5000])
    expect(tokenRequests[0]!.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
  })

  it("adds five seconds to every later wait after slow_down", async () => {
    replies = [{ status: 400, body: { error: "slow_down" } }, { status: 400, body: { error: "authorization_pending" } }, await withToken(goodClaims())]
    const { pass, waits } = makePass()
    await (await pass.start()).result
    expect(waits).toEqual([5000, 10000, 10000])
  })

  it.each([
    [{ status: 400, body: { error: "access_denied" } }, "denied"],
    [{ status: 400, body: { error: "expired_token" } }, "expired"],
    [{ status: 400, body: { error: "invalid_grant" } }, "invalid"],
    [{ status: 400, body: { error: "something_new" } }, "invalid"],
    [{ status: 503, body: {} }, "unavailable"],
    [{ status: 429, body: {} }, "unavailable"],
  ])("stops at %j", async (reply, reason) => {
    replies = [reply as TokenReply, { status: 400, body: { error: "authorization_pending" } }]
    const result = await (await makePass().pass.start()).result
    expect(result).toMatchObject({ ok: false, reason })
    expect(tokenRequests).toHaveLength(1)
  })

  it("expires on its own clock when nobody answers", async () => {
    startReply = { status: 200, body: { device_code: DEVICE_CODE, user_code: "X", verification_uri: "u", expires_in: 12, interval: 5 } }
    const result = await (await makePass().pass.start()).result
    expect(result).toMatchObject({ ok: false, reason: "expired" })
    expect(tokenRequests).toHaveLength(2)
  })

  it("can be cancelled, for example when a STOP arrives during the wait", async () => {
    const pass = new AgentPass({ issuer, clientId: CLIENT, clientSecret: SECRET, wait: () => new Promise(() => undefined) })
    const attempt = await pass.start()
    attempt.cancel()
    expect(await attempt.result).toMatchObject({ ok: false, reason: "cancelled" })
    expect(tokenRequests).toHaveLength(0)
  })

  it("treats a token arriving after cancelling as cancelled", async () => {
    let attempt: Awaited<ReturnType<AgentPass["start"]>> | undefined
    const { pass } = makePass()
    replies = [
      async () => {
        attempt?.cancel()
        return withToken(goodClaims())
      },
    ]
    attempt = await pass.start()
    expect(await attempt.result).toMatchObject({ ok: false, reason: "cancelled" })
  })

  it("backs off when a poll cannot reach World, and never counts that as approval", async () => {
    let calls = 0
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/token") && ++calls === 1) throw new Error("connection timed out")
      return fetch(input, init)
    }
    replies = [await withToken(goodClaims())]
    const { pass, waits } = makePass({ fetch: flaky })
    expect(await (await pass.start()).result).toMatchObject({ ok: true })
    expect(waits).toEqual([5000, 10000])
  })
})

describe("validating", () => {
  const outcome = async (reply: TokenReply) => {
    replies = [reply]
    return (await makePass().pass.start()).result
  }

  it("refuses a token signed with the wrong key", async () => {
    expect(await outcome(await withToken(goodClaims(), { key: "other" }))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a token from another issuer", async () => {
    expect(await outcome(await withToken(goodClaims(), { issuer: "https://evil.example" }))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a token meant for another app", async () => {
    expect(await outcome(await withToken(goodClaims(), { audience: "other-client" }))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses an unsigned token", async () => {
    const part = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, "")
    const forged = `${part({ alg: "none" })}.${part({ ...goodClaims(), iss: issuer, aud: CLIENT, exp: nowS() + 60, iat: nowS() })}.`
    expect(await outcome({ status: 200, body: { id_token: forged } })).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a lower class of person", async () => {
    expect(await outcome(await withToken({ ...goodClaims(), acr: "https://world.org/oidc/acr/selfie" }))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it.each(["acr", "amr", "auth_time"])("refuses a token with no %s", async (claim) => {
    const claims: Record<string, unknown> = goodClaims()
    delete claims[claim]
    expect(await outcome(await withToken(claims))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses an authentication from before this attempt", async () => {
    const result = await outcome(await withToken({ ...goodClaims(), auth_time: nowS() - 600 }))
    expect(result).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("during this request") })
  })

  it("refuses an authentication from the future", async () => {
    expect(await outcome(await withToken({ ...goodClaims(), auth_time: nowS() + 600 }))).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("refuses a success with no token", async () => {
    expect(await outcome({ status: 200, body: { access_token: "opaque" } })).toMatchObject({ ok: false, reason: "invalid" })
  })
})

describe("configuration", () => {
  it("is off with no credentials", () => {
    expect(agentPassFromEnv({})).toBeUndefined()
  })

  it("refuses half a configuration", () => {
    expect(() => agentPassFromEnv({ WORLD_IDP_CLIENT_ID: "x" })).toThrow("both")
    expect(() => agentPassFromEnv({ WORLD_IDP_CLIENT_SECRET: "x" })).toThrow("both")
  })

  it("uses production unless told otherwise", () => {
    const pass = agentPassFromEnv({ WORLD_IDP_CLIENT_ID: "x", WORLD_IDP_CLIENT_SECRET: "y" })
    expect(pass?.opts.issuer).toBe("https://auth.world.org")
    expect(pass?.opts.authMethod).toBe("client_secret_basic")
    const sandbox = agentPassFromEnv({ WORLD_IDP_CLIENT_ID: "x", WORLD_IDP_CLIENT_SECRET: "y", WORLD_IDP_ISSUER: "https://sandbox.auth.world.org" })
    expect(sandbox?.opts.issuer).toBe("https://sandbox.auth.world.org")
  })
})
