import { confirmationSignal as signalFor, type EndorseRow, type Hex, type RecallRow, type Stance } from "@ceasenet/core"
import { hashSignal } from "@worldcoin/idkit-core/hashing"
import { beforeEach, describe, expect, it } from "vitest"
import { CONFIRM_ACTION, humanId, Refused, Verifier, type WorldEnvironment } from "../src/verifier"

const RECALL = `0x${"a".repeat(64)}` as Hex
const OTHER = `0x${"b".repeat(64)}` as Hex
// A throwaway key, used only for these tests.
const KEY = `0x${"1".repeat(64)}`

const WARNING: RecallRow = {
  key: RECALL,
  artifact: "0xbad",
  level: "ADVISORY",
  severity: "HIGH",
  reason: "r",
  contentHash: "0xc",
  creator: "0x00000000000000000000000000000000000000cc",
  createdAt: 1n,
  expiresAt: 9n,
}

interface Setup {
  world?: () => Response | Promise<Response>
  environment?: WorldEnvironment
}

function make({ world, environment = "staging" }: Setup = {}) {
  const written: { recall: Hex; stance: Stance; human: string }[] = []
  const sentToWorld: any[] = []
  let urls: string[] = []
  const clock = { t: 1_000_000 }
  const verifier = new Verifier({
    rpId: "rp_test",
    signingKey: KEY,
    environment,
    readWarning: async (recall) => (recall === RECALL ? WARNING : undefined),
    readEndorsements: async (recall) =>
      written
        .filter((w) => w.recall === recall)
        .map((w, i): EndorseRow => ({ key: `0x${i}`, recall, stance: w.stance, human: w.human, creator: WARNING.creator, createdAt: 2n })),
    endorse: async (input) => {
      written.push(input)
      return { entityKey: "0xe1" as Hex, txHash: "0xe2" as Hex }
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      urls.push(url)
      sentToWorld.push(JSON.parse(init.body as string))
      return world ? world() : new Response(JSON.stringify({ success: true, environment }), { status: 200 })
    }) as unknown as typeof fetch,
    now: () => clock.t,
  })
  /** A result as IDKit would hand it over, with a nonce this verifier really issued. */
  const result = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}, recall = RECALL, stance = "CONFIRM") => ({
    protocol_version: "4.0",
    nonce: verifier.rpSignature().nonce,
    action: CONFIRM_ACTION,
    environment,
    responses: [
      {
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        signal_hash: hashSignal(signalFor(recall, stance)),
        nullifier: "12345",
        expires_at_min: 1,
        proof: ["1", "2", "3", "4", "5"],
        ...item,
      },
    ],
    ...over,
  })
  return { verifier, written, sentToWorld, urls: () => urls, result, clock }
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

describe("confirming a warning", () => {
  it("counts a good proof, after World has checked it", async () => {
    const m = make()
    const done = await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() })
    expect(m.urls()).toEqual(["https://developer.world.org/api/v4/verify/rp_test"])
    expect(m.written).toEqual([{ recall: RECALL, stance: "CONFIRM", human: humanId("12345", RECALL) }])
    expect(done.key).toBe("0xe1")
  })

  it("forwards the proof to World unchanged", async () => {
    const m = make()
    const result = m.result()
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result })
    expect(m.sentToWorld[0]).toEqual(result)
  })

  it("does not put the person's World ID value on the record", async () => {
    const m = make()
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() })
    expect(JSON.stringify(m.written)).not.toContain("12345")
  })

  it("gives one person different values on different warnings, so they cannot be followed", () => {
    expect(humanId("12345", RECALL)).not.toBe(humanId("12345", OTHER))
    expect(humanId("12345", RECALL)).toBe(humanId("12345", RECALL.toUpperCase().replace("0X", "0x")))
  })

  it("records a dispute as a dispute", async () => {
    const m = make()
    await m.verifier.confirm({ recall: RECALL, stance: "DISPUTE", result: m.result({}, {}, RECALL, "DISPUTE") })
    expect(m.written[0]?.stance).toBe("DISPUTE")
  })
})

describe("what it refuses", () => {
  let m: ReturnType<typeof make>
  beforeEach(() => {
    m = make()
  })

  const expectNothingCounted = () => expect(m.written).toEqual([])

  it("the same person answering a warning twice", async () => {
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() }), "already_counted")
    expect(m.written).toHaveLength(1)
  })

  it("the same person confirming and then disputing", async () => {
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() })
    await refusedWith(
      m.verifier.confirm({ recall: RECALL, stance: "DISPUTE", result: m.result({}, {}, RECALL, "DISPUTE") }),
      "already_counted",
    )
  })

  it("a proof made for a different warning", async () => {
    const forOther = m.result({}, {}, OTHER)
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: forOther }), "wrong_signal")
    expectNothingCounted()
    expect(m.urls()).toEqual([])
  })

  it("a proof made to confirm, used to dispute", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "DISPUTE", result: m.result() }), "wrong_signal")
    expectNothingCounted()
  })

  it("a proof with no signal", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({}, { signal_hash: undefined }) }), "wrong_signal")
  })

  it("a proof the verifier did not ask for", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({ nonce: "made-up" }) }), "stale_request")
    expectNothingCounted()
  })

  it("the same proof used twice", async () => {
    const result = m.result()
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result }), "stale_request")
    expect(m.written).toHaveLength(1)
  })

  it("a proof after its request has expired", async () => {
    const result = m.result()
    m.clock.t += 301_000
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result }), "stale_request")
  })

  it("a proof from another environment", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({ environment: "production" }) }), "wrong_environment")
    expectNothingCounted()
  })

  it("a test proof when it is set up for real ones", async () => {
    const real = make({ environment: "production" })
    await refusedWith(real.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: real.result({ environment: "staging" }) }), "wrong_environment")
  })

  it("a proof made for another action", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({ action: "something-else" }) }), "wrong_action")
  })

  it("a weaker or different credential", async () => {
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({}, { identifier: "selfie" }) }), "wrong_credential")
  })

  it("a warning that does not exist", async () => {
    const result = m.result({}, {}, OTHER)
    await refusedWith(m.verifier.confirm({ recall: OTHER, stance: "CONFIRM", result }), "no_such_warning")
    expect(m.urls()).toEqual([])
  })

  it("nonsense", async () => {
    await refusedWith(m.verifier.confirm({ recall: "0x12" as Hex, stance: "CONFIRM", result: m.result() }), "bad_request")
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "MAYBE" as Stance, result: m.result() }), "bad_request")
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: null }), "bad_request")
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result({ responses: [] }) }), "no_proof")
  })
})

describe("when World says no", () => {
  it("counts nothing when World rejects the proof, and passes on its reason", async () => {
    const m = make({ world: () => new Response(JSON.stringify({ success: false, code: "all_verifications_failed", detail: "No." }), { status: 400 }) })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() }), "all_verifications_failed")
    expect(m.written).toEqual([])
  })

  it("counts nothing on a success that is not clearly a yes", async () => {
    const m = make({ world: () => new Response(JSON.stringify({ environment: "staging" }), { status: 200 }) })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() }), "world_rejected")
    expect(m.written).toEqual([])
  })

  it("counts nothing when World answers for another environment", async () => {
    const m = make({ world: () => new Response(JSON.stringify({ success: true, environment: "production" }), { status: 200 }) })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() }), "wrong_environment")
    expect(m.written).toEqual([])
  })

  it("counts nothing when World cannot be reached, and lets the person try again", async () => {
    let down = true
    const m = make({
      world: () => {
        if (down) throw new Error("offline")
        return new Response(JSON.stringify({ success: true, environment: "staging" }), { status: 200 })
      },
    })
    const result = m.result()
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result }), "world_unreachable")
    expect(m.written).toEqual([])
    down = false
    await m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result })
    expect(m.written).toHaveLength(1)
  })

  it("counts nothing when World's reply cannot be read", async () => {
    const m = make({ world: () => new Response("not json", { status: 200 }) })
    await refusedWith(m.verifier.confirm({ recall: RECALL, stance: "CONFIRM", result: m.result() }), "world_rejected")
    expect(m.written).toEqual([])
  })
})
