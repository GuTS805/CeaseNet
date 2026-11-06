import { type EndorseRow, type Hex, type HumanRow, loginMessage, loginSignal, openRecallMessage, type RecallRow, type Stance, voteMessage } from "@ceasenet/core"
import { hashSignal } from "@worldcoin/idkit-core/hashing"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { AlreadyReported, CONFIRM_ACTION, humanId, Refused, reportArtifact, Verifier, type WorldEnvironment } from "../src/verifier"

const RECALL = `0x${"a".repeat(64)}` as Hex
const FILED = `0x${"c".repeat(64)}` as Hex
const AGENT = "0x00000000000000000000000000000000000000ab"
const REASON = "It copies every email to a stranger"
// Throwaway keys, used only for these tests.
const KEY = `0x${"1".repeat(64)}`
const ALICE = privateKeyToAccount(`0x${"2".repeat(64)}`)
const BOB = privateKeyToAccount(`0x${"3".repeat(64)}`)

const WARNING: RecallRow = {
  key: RECALL,
  artifact: "0xbad",
  level: "ADVISORY",
  severity: "REPORT",
  reason: "r",
  contentHash: "0xc",
  creator: "0x00000000000000000000000000000000000000cc",
  createdAt: 1n,
  expiresAt: 9n,
}

interface Setup {
  world?: () => Response | Promise<Response>
  environment?: WorldEnvironment
  open?: boolean
  exists?: boolean
}

function make({ world, environment = "staging", open: alreadyOpen = false, exists = true }: Setup = {}) {
  const votes: { recall: Hex; stance: Stance; human: string }[] = []
  const humans: HumanRow[] = []
  const reports: { artifact: string; reason: string; pkg?: string; versions?: string; opener: Hex }[] = []
  const sentToWorld: any[] = []
  const urls: string[] = []
  const clock = { t: 1_000_000 }
  const verifier = new Verifier({
    rpId: "rp_test",
    signingKey: KEY,
    environment,
    readWarning: async (recall) => (recall === RECALL ? WARNING : recall === FILED ? { ...WARNING, key: FILED } : undefined),
    readEndorsements: async (recall) =>
      votes
        .filter((w) => w.recall === recall)
        .map((w, i): EndorseRow => ({ key: `0x${i}`, recall, stance: w.stance, human: w.human, creator: WARNING.creator, createdAt: 2n })),
    endorse: async (input) => {
      votes.push(input)
      return { entityKey: "0xe1" as Hex, txHash: "0xe2" as Hex }
    },
    readHuman: async (address) => humans.find((h) => h.address.toLowerCase() === address.toLowerCase()),
    readHumanById: async (human) => humans.find((h) => h.human === human),
    writeHuman: async (input) => {
      humans.push({ key: `0x${String(humans.length + 1).padStart(64, "0")}` as Hex, address: input.address, human: input.human, creator: WARNING.creator, createdAt: 3n })
      return { entityKey: humans.at(-1)!.key, txHash: "0xe2" as Hex }
    },
    readOpenReports: async () => (alreadyOpen ? [{ ...WARNING, key: FILED }] : []),
    agentExists: async () => exists,
    fileReport: async (input) => {
      reports.push(input)
      return { entityKey: FILED, txHash: "0xe2" as Hex }
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      urls.push(url)
      sentToWorld.push(JSON.parse(init.body as string))
      return world ? world() : new Response(JSON.stringify({ success: true, environment }), { status: 200 })
    }) as unknown as typeof fetch,
    now: () => clock.t,
  })

  /** A result as IDKit would hand it over, with a nonce this verifier really issued. */
  const result = (address: string, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
    protocol_version: "4.0",
    nonce: verifier.rpSignature().nonce,
    action: CONFIRM_ACTION,
    environment,
    responses: [
      {
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        signal_hash: hashSignal(loginSignal(address)),
        nullifier: "12345",
        expires_at_min: 1,
        proof: ["1", "2", "3", "4", "5"],
        ...item,
      },
    ],
    ...over,
  })

  const signLogin = async (account = ALICE, at = clock.t) => ({ address: account.address, at, signature: await account.signMessage({ message: loginMessage(account.address, at) }) })
  const login = async (account = ALICE, nullifier = "12345") =>
    verifier.login({ ...(await signLogin(account)), result: result(account.address, {}, { nullifier }) })
  const vote = async (account = ALICE, stance: Stance = "CONFIRM", recall = RECALL, at = clock.t) =>
    verifier.confirm({ recall, stance, address: account.address, at, signature: await account.signMessage({ message: voteMessage(recall, stance, at) }) })
  const open = async (account = ALICE, target: any = { kind: "agent", address: AGENT }, reason = REASON, at = clock.t) =>
    verifier.report({ target, reason, address: account.address, at, signature: await account.signMessage({ message: openRecallMessage(reportArtifact(target).artifact, reason.trim(), at) }) })

  return { verifier, votes, humans, reports, sentToWorld, urls, result, clock, signLogin, login, vote, open }
}

const refusedWith = async (attempt: Promise<unknown>, code: string) => {
  const e = await attempt.then(
    () => undefined,
    (x) => x,
  )
  expect(e).toBeInstanceOf(Refused)
  expect((e as Refused).code).toBe(code)
}

describe("signing a request", () => {
  it("returns what IDKit needs and never the key", () => {
    const { verifier } = make()
    const sig = verifier.rpSignature()
    expect(Object.keys(sig).sort()).toEqual(["created_at", "expires_at", "nonce", "sig"])
    expect(JSON.stringify(sig)).not.toContain("1".repeat(64))
  })

  it("gives a different nonce each time", () => {
    const { verifier } = make()
    expect(verifier.rpSignature().nonce).not.toBe(verifier.rpSignature().nonce)
  })
})

describe("logging in with World", () => {
  it("links one person to the wallet that signed, after World has checked the proof", async () => {
    const m = make()
    const done = await m.login()
    expect(m.urls).toEqual(["https://developer.world.org/api/v4/verify/rp_test"])
    expect(m.humans).toEqual([expect.objectContaining({ address: ALICE.address.toLowerCase(), human: humanId("12345", "login") })])
    expect(done).toMatchObject({ address: ALICE.address.toLowerCase(), already: false })
  })

  it("forwards the proof to World unchanged", async () => {
    const m = make()
    const result = m.result(ALICE.address)
    await m.verifier.login({ ...(await m.signLogin()), result })
    expect(m.sentToWorld[0]).toEqual(result)
  })

  it("does not put the person's World ID value on the record", async () => {
    const m = make()
    await m.login()
    expect(m.humans.map((h) => `${h.address} ${h.human}`).join()).not.toContain("12345")
  })

  it("changes nothing when the same person logs in again with the same wallet", async () => {
    const m = make()
    await m.login()
    const again = await m.login()
    expect(again.already).toBe(true)
    expect(m.humans).toHaveLength(1)
  })

  it("will not link one person to a second wallet", async () => {
    const m = make()
    await m.login(ALICE)
    await refusedWith(m.login(BOB), "other_address")
    expect(m.humans).toHaveLength(1)
  })

  it("will not link a second person to a wallet already linked", async () => {
    const m = make()
    await m.login(ALICE, "12345")
    await refusedWith(m.login(ALICE, "99999"), "other_person")
  })

  it("refuses a proof made for a different wallet", async () => {
    const m = make()
    await refusedWith(m.verifier.login({ ...(await m.signLogin(ALICE)), result: m.result(BOB.address) }), "wrong_signal")
    expect(m.humans).toEqual([])
  })

  it("refuses a wallet that did not sign", async () => {
    const m = make()
    const signed = await m.signLogin(BOB)
    await refusedWith(m.verifier.login({ ...signed, address: ALICE.address, result: m.result(ALICE.address) }), "bad_signature")
    await refusedWith(m.verifier.login({ address: ALICE.address, at: m.clock.t, signature: "nope" as Hex, result: m.result(ALICE.address) }), "not_signed")
  })

  it("refuses an old signature", async () => {
    const m = make()
    const signed = await m.signLogin(ALICE, m.clock.t - 11 * 60_000)
    await refusedWith(m.verifier.login({ ...signed, result: m.result(ALICE.address) }), "stale_request")
  })

  it("refuses the same proof twice, and a proof it did not ask for", async () => {
    const m = make()
    const result = m.result(ALICE.address)
    await m.verifier.login({ ...(await m.signLogin()), result })
    await refusedWith(m.verifier.login({ ...(await m.signLogin()), result }), "stale_request")
    await refusedWith(m.verifier.login({ ...(await m.signLogin()), result: { ...m.result(ALICE.address), nonce: "made-up" } }), "stale_request")
  })

  it("refuses another environment, another action and a weaker credential", async () => {
    const m = make()
    const s = await m.signLogin()
    await refusedWith(m.verifier.login({ ...s, result: m.result(ALICE.address, { environment: "production" }) }), "wrong_environment")
    await refusedWith(m.verifier.login({ ...s, result: m.result(ALICE.address, { action: "other" }) }), "wrong_action")
    await refusedWith(m.verifier.login({ ...s, result: m.result(ALICE.address, {}, { identifier: "passport" }) }), "wrong_credential")
  })

  it("takes the legacy format an older World App answers in, and still checks it", async () => {
    const m = make()
    const legacy = { ...m.result(ALICE.address, { protocol_version: "3.0" }, { identifier: "orb", nullifier: "0xabc", merkle_root: "0x1" }) }
    const done = await m.verifier.login({ ...(await m.signLogin()), result: legacy })
    expect(done.already).toBe(false)
    expect(m.sentToWorld[0]).toEqual(legacy)
    await refusedWith(m.verifier.login({ ...(await m.signLogin()), result: m.result(ALICE.address, { protocol_version: "3.0" }, { identifier: "device" }) }), "wrong_credential")
    await refusedWith(m.verifier.login({ ...(await m.signLogin()), result: m.result(ALICE.address, {}, { identifier: "orb" }) }), "wrong_credential")
  })

  it("logs nobody in when World says no, or cannot be reached", async () => {
    const no = make({ world: () => new Response(JSON.stringify({ success: false, code: "invalid_proof", detail: "Bad proof" }), { status: 400 }) })
    await refusedWith(no.login(), "invalid_proof")
    expect(no.humans).toEqual([])
    const down = make({
      world: () => {
        throw new Error("offline")
      },
    })
    await refusedWith(down.login(), "world_unreachable")
    const other = make({ world: () => new Response(JSON.stringify({ success: true, environment: "production" }), { status: 200 }) })
    await refusedWith(other.login(), "wrong_environment")
  })
})

describe("voting on a normal recall", () => {
  it("counts a logged-in person's vote, under their address", async () => {
    const m = make()
    await m.login()
    const done = await m.vote()
    expect(m.votes).toEqual([{ recall: RECALL, stance: "CONFIRM", human: ALICE.address.toLowerCase() }])
    expect(done.key).toBe("0xe1")
  })

  it("records a vote against as one", async () => {
    const m = make()
    await m.login()
    await m.vote(ALICE, "DISPUTE")
    expect(m.votes[0]?.stance).toBe("DISPUTE")
  })

  it("needs a login first", async () => {
    const m = make()
    await refusedWith(m.vote(), "not_logged_in")
    expect(m.votes).toEqual([])
  })

  it("counts one vote per person", async () => {
    const m = make()
    await m.login()
    await m.vote(ALICE, "CONFIRM")
    await refusedWith(m.vote(ALICE, "DISPUTE"), "already_counted")
    expect(m.votes).toHaveLength(1)
  })

  it("refuses a vote signed for something else", async () => {
    const m = make()
    await m.login()
    const at = m.clock.t
    const signature = await ALICE.signMessage({ message: voteMessage(RECALL, "DISPUTE", at) })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", address: ALICE.address, at, signature }), "bad_signature")
  })

  it("refuses a recall that does not exist, and nonsense", async () => {
    const m = make()
    await m.login()
    await refusedWith(m.vote(ALICE, "CONFIRM", `0x${"9".repeat(64)}` as Hex), "no_such_warning")
    await refusedWith(m.verifier.confirm({ recall: "0x12" as Hex, stance: "CONFIRM", address: ALICE.address, at: 1, signature: "0x" as Hex }), "bad_request")
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "MAYBE" as Stance, address: ALICE.address, at: 1, signature: "0x" as Hex }), "bad_request")
  })
})

describe("opening a normal recall", () => {
  it("opens it in the person's name, and counts it as their vote", async () => {
    const m = make()
    await m.login()
    const done = await m.open()
    expect(done.key).toBe(FILED)
    expect(m.reports).toEqual([{ artifact: `agent:${AGENT}`, reason: REASON, opener: ALICE.address.toLowerCase() }])
    expect(m.votes).toEqual([{ recall: FILED, stance: "CONFIRM", human: ALICE.address.toLowerCase() }])
  })

  it("will not let the opener vote again on it", async () => {
    const m = make()
    await m.login()
    await m.open()
    await refusedWith(m.vote(ALICE, "CONFIRM", FILED), "already_counted")
  })

  it("needs a login first", async () => {
    const m = make()
    await refusedWith(m.open(), "not_logged_in")
    expect(m.reports).toEqual([])
  })

  it("sends someone to the open recall, rather than opening another", async () => {
    const m = make({ open: true })
    await m.login()
    const e = await m.open().catch((x) => x)
    expect(e).toBeInstanceOf(AlreadyReported)
    expect((e as AlreadyReported).key).toBe(FILED)
  })

  it("will not open one on an agent nobody has registered", async () => {
    const m = make({ exists: false })
    await m.login()
    await refusedWith(m.open(), "no_such_agent")
  })

  it("wants a real reason", async () => {
    const m = make()
    await m.login()
    await refusedWith(m.open(ALICE, { kind: "agent", address: AGENT }, "bad"), "bad_reason")
  })

  it("refuses a signature made for a different reason", async () => {
    const m = make()
    await m.login()
    const at = m.clock.t
    const signature = await ALICE.signMessage({ message: openRecallMessage(`agent:${AGENT}`, "Something else entirely", at) })
    await refusedWith(m.verifier.report({ target: { kind: "agent", address: AGENT }, reason: REASON, address: ALICE.address, at, signature }), "bad_signature")
  })

  it("limits how many one person can open", async () => {
    const m = make()
    await m.login()
    for (let i = 0; i < 5; i++) await m.open()
    await refusedWith(m.open(), "too_many_reports")
  })

  it("names a tool by package and version", () => {
    expect(reportArtifact({ kind: "tool", name: "some-mcp", version: "1.2.3" })).toEqual({ artifact: "package:some-mcp", pkg: "some-mcp", versions: "1.2.3" })
    expect(reportArtifact({ kind: "tool", name: "some-mcp" }).versions).toBe("*")
    expect(() => reportArtifact({ kind: "agent", address: "nope" })).toThrow(Refused)
  })
})
