import { describe, expect, it } from "vitest"
import { checkRpcUrl, PUBLIC_RPC, quotaAwareFetch } from "../src/arkiv"
import { checkListFresh, MAX_LIST_AGE_MS } from "../src/reader"

const KEYED = `${PUBLIC_RPC}my-key`
const answer = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers })

function setup(respond: (url: string) => Response) {
  const asked: string[] = []
  const clock = { t: 1_000 }
  const { fetchFn, status } = quotaAwareFetch(
    (async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return respond(String(input))
    }) as typeof fetch,
    () => clock.t,
  )
  return { fetchFn, status, asked, clock }
}

const quotaGone = () => answer(429, '{"error":"QUOTA_EXCEEDED","message":"quota exhausted"}', { "arkiv-quota-used-percent": "100" })

describe("an access key whose quota has run out", () => {
  it("is used while it works, and its quota is noted", async () => {
    const s = setup(() => answer(200, "{}", { "arkiv-quota-used-percent": "42" }))
    const res = await s.fetchFn(KEYED, { method: "POST" })
    expect(res.status).toBe(200)
    expect(s.asked).toEqual([KEYED])
    expect(s.status).toEqual({ usedPercent: 42, exhausted: false })
  })

  it("does not fail the request: the same request goes out with no key", async () => {
    const s = setup((url) => (url === KEYED ? quotaGone() : answer(200, '{"result":"ok"}')))
    const res = await s.fetchFn(KEYED, { method: "POST", body: "the same body" })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("ok")
    expect(s.asked).toEqual([KEYED, PUBLIC_RPC])
    expect(s.status).toEqual({ usedPercent: 100, exhausted: true })
  })

  it("is left alone for a while, so each request does not waste a trip", async () => {
    const s = setup((url) => (url === KEYED ? quotaGone() : answer(200, "{}")))
    await s.fetchFn(KEYED)
    await s.fetchFn(KEYED)
    await s.fetchFn(KEYED)
    expect(s.asked).toEqual([KEYED, PUBLIC_RPC, PUBLIC_RPC, PUBLIC_RPC])
  })

  it("is tried again later, and used if its quota has come back", async () => {
    let gone = true
    const s = setup((url) => (url === KEYED && gone ? quotaGone() : answer(200, "{}")))
    await s.fetchFn(KEYED)
    gone = false
    s.clock.t += 11 * 60_000
    await s.fetchFn(KEYED)
    expect(s.asked[s.asked.length - 1]).toBe(KEYED)
    expect(s.status.exhausted).toBe(false)
  })

  it("is not confused with being sent too much at once, which is a different refusal", async () => {
    const s = setup(() => answer(429, '{"error":"RATE_LIMITED"}'))
    const res = await s.fetchFn(KEYED)
    expect(res.status).toBe(429)
    expect(s.asked).toEqual([KEYED])
    expect(s.status.exhausted).toBe(false)
  })

  it("does not touch a request that has no key, or goes anywhere else", async () => {
    const s = setup(() => quotaGone())
    await s.fetchFn(PUBLIC_RPC)
    await s.fetchFn("https://example.com/other")
    expect(s.asked).toEqual([PUBLIC_RPC, "https://example.com/other"])
    expect(s.status.exhausted).toBe(false)
  })
})

const keyRefused = () => answer(401, '{"error":"INVALID_KEY"}')

describe("an access key the network no longer accepts", () => {
  it("does not fail the request: the same request goes out with no key", async () => {
    const s = setup((url) => (url === KEYED ? keyRefused() : answer(200, '{"result":"ok"}')))
    const res = await s.fetchFn(KEYED, { method: "POST", body: "the same body" })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("ok")
    expect(s.asked).toEqual([KEYED, PUBLIC_RPC])
    expect(s.status.rejected).toBe(true)
    expect(s.status.exhausted).toBe(false)
  })

  it("is left alone for a while, then tried again and used if it works", async () => {
    let refused = true
    const s = setup((url) => (url === KEYED && refused ? keyRefused() : answer(200, "{}")))
    await s.fetchFn(KEYED)
    await s.fetchFn(KEYED)
    expect(s.asked).toEqual([KEYED, PUBLIC_RPC, PUBLIC_RPC])
    refused = false
    s.clock.t += 11 * 60_000
    await s.fetchFn(KEYED)
    expect(s.asked[s.asked.length - 1]).toBe(KEYED)
    expect(s.status.rejected).toBe(false)
  })

  it("leaves a request with no key alone, even when it is refused", async () => {
    const s = setup(() => keyRefused())
    const res = await s.fetchFn(PUBLIC_RPC)
    expect(res.status).toBe(401)
    expect(s.asked).toEqual([PUBLIC_RPC])
  })
})

describe("a node the owner chooses", () => {
  it("takes a web address and gives it back in its usual form", () => {
    expect(checkRpcUrl(" https://node.example ")).toBe("https://node.example/")
    expect(checkRpcUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545/")
  })

  it("refuses anything that is not a web address", () => {
    expect(() => checkRpcUrl("node.example")).toThrow("not a web address")
    expect(() => checkRpcUrl("ws://node.example")).toThrow("https:// or http://")
    expect(() => checkRpcUrl("file:///etc/passwd")).toThrow("https:// or http://")
  })

  it("sends a chosen node nothing of the access key", async () => {
    const seen: string[] = []
    const { fetchFn } = quotaAwareFetch(async (input) => {
      seen.push(String(input))
      return answer(200, "{}")
    })
    await fetchFn("https://node.example/", { method: "POST" })
    expect(seen).toEqual(["https://node.example/"])
  })
})

describe("a list that is not live", () => {
  const now = 1_800_000_000_000
  const secondsAgo = (s: number) => BigInt(now / 1000 - s)

  it("accepts a block from a moment ago", () => {
    expect(() => checkListFresh(secondsAgo(2), now)).not.toThrow()
    expect(() => checkListFresh(secondsAgo(MAX_LIST_AGE_MS / 1000), now)).not.toThrow()
  })

  it("accepts a block slightly ahead of this machine's clock", () => {
    expect(() => checkListFresh(secondsAgo(-5), now)).not.toThrow()
  })

  it("refuses a node that has fallen behind or stopped", () => {
    expect(() => checkListFresh(secondsAgo(MAX_LIST_AGE_MS / 1000 + 1), now)).toThrow("121 seconds old")
    expect(() => checkListFresh(secondsAgo(3600), now)).toThrow("not serving the live list")
  })
})
