import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { type AgentPass, approverFromPass, type ApproverLinks, fileLinks, matchesLink, type PassAttempt, type PassResult } from "../src/agentPass"

const REQUEST = { file: { kind: "tool", name: "tool", version: "1", hash: "0x1" }, action: "send", reason: "A warning covers it." }
const PERSON: Extract<PassResult, { ok: true }> = { ok: true, issuer: "https://auth.world.org", subject: "person-1", acr: "orb", amr: ["pop"], authTime: 1 }

function fakePass(result?: PassResult) {
  let settle: (r: PassResult) => void = () => undefined
  const cancel = vi.fn(() => settle({ ok: false, reason: "cancelled", message: "The request was cancelled." }))
  const attempt: PassAttempt = {
    userCode: "ABCD",
    verificationUri: "https://auth.world.org/device",
    expiresAt: Date.now() + 60_000,
    result: result
      ? Promise.resolve(result)
      : new Promise((r) => {
          settle = r
        }),
    cancel,
  }
  return { pass: { start: async () => attempt } as unknown as AgentPass, cancel }
}

const memoryLinks = (): ApproverLinks => {
  const saved = new Map<string, { issuer: string; subject: string }>()
  return { get: (a) => saved.get(a), set: (a, i) => void saved.set(a, i) }
}

const signal = () => new AbortController().signal

describe("the proxy's approver", () => {
  it("prints where to approve, and never the device code or subject", async () => {
    const lines: string[] = []
    const { pass } = fakePass(PERSON)
    expect(await approverFromPass(pass, memoryLinks(), "owner", (l) => lines.push(l))(REQUEST, signal())).toBe("APPROVED")
    expect(lines.join()).toContain("ABCD")
    expect(lines.join()).toContain("send on tool 1")
    expect(lines.join()).not.toContain("person-1")
  })

  it.each([
    ["denied", "DENIED"],
    ["expired", "EXPIRED"],
    ["invalid", "EXPIRED"],
    ["unavailable", "EXPIRED"],
  ] as const)("a %s result never approves", async (reason, expected) => {
    const { pass } = fakePass({ ok: false, reason, message: "No." })
    expect(await approverFromPass(pass, memoryLinks(), "owner", () => undefined)(REQUEST, signal())).toBe(expected)
  })

  it("refuses a person other than the linked one", async () => {
    const links = memoryLinks()
    links.set("owner", { issuer: PERSON.issuer, subject: "person-2" })
    const { pass } = fakePass(PERSON)
    expect(await approverFromPass(pass, links, "owner", () => undefined)(REQUEST, signal())).toBe("DENIED")
  })

  it("cancels the attempt when a STOP ends the wait", async () => {
    const abort = new AbortController()
    const { pass, cancel } = fakePass()
    const waiting = approverFromPass(pass, memoryLinks(), "owner", () => undefined)(REQUEST, abort.signal)
    await new Promise((r) => setTimeout(r, 0))
    abort.abort()
    expect(await waiting).toBe("EXPIRED")
    expect(cancel).toHaveBeenCalled()
  })

  it("refuses when World can't be asked at all", async () => {
    const broken = { start: async () => Promise.reject(new Error("no route")) } as unknown as AgentPass
    const lines: string[] = []
    expect(await approverFromPass(broken, memoryLinks(), "owner", (l) => lines.push(l))(REQUEST, signal())).toBe("EXPIRED")
    expect(lines.join()).toContain("no route")
  })
})

describe("links", () => {
  const dir = mkdtempSync(join(tmpdir(), "ceasenet-links-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("the first person links, and only they match after that", () => {
    const links = memoryLinks()
    expect(matchesLink(links, "owner", PERSON)).toBe(true)
    expect(matchesLink(links, "owner", PERSON)).toBe(true)
    expect(matchesLink(links, "owner", { ...PERSON, subject: "person-2" })).toBe(false)
    expect(matchesLink(links, "owner", { ...PERSON, issuer: "https://sandbox.auth.world.org" })).toBe(false)
  })

  it("survive a restart, and ignore the case of an address", () => {
    const path = join(dir, "nested", "approvers.json")
    expect(existsSync(path)).toBe(false)
    expect(fileLinks(path).get("0xABC")).toBeUndefined()
    fileLinks(path).set("0xABC", { issuer: PERSON.issuer, subject: PERSON.subject })
    expect(fileLinks(path).get("0xabc")?.subject).toBe(PERSON.subject)
  })
})
