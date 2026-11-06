import type { ApproverLinks, PassAttempt, PassResult } from "@ceasenet/guard"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApprovalDesk } from "../src/approvals"

const REQUEST = { file: { kind: "tool", name: "demo-mail-tool", version: "1.0.16", hash: "0x1" }, action: "send_email", reason: "A warning covers it." }
const PERSON: PassResult = { ok: true, issuer: "https://auth.world.org", subject: "person-1", acr: "orb", amr: ["pop"], authTime: 1 }

function fakePass() {
  let settle: (r: PassResult) => void = () => undefined
  const cancel = vi.fn(() => settle({ ok: false, reason: "cancelled", message: "The request was cancelled." }))
  const attempt: PassAttempt = {
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.world.org/device",
    verificationUriComplete: "https://auth.world.org/device?code=ABCD-EFGH",
    expiresAt: Date.now() + 1_200_000,
    result: new Promise((r) => {
      settle = r
    }),
    cancel,
  }
  return { start: vi.fn(async () => attempt), attempt, cancel, finish: (r: PassResult) => settle(r) }
}

const memoryLinks = (): ApproverLinks => {
  const saved = new Map<string, { issuer: string; subject: string }>()
  return { get: (a) => saved.get(a), set: (a, i) => void saved.set(a, i) }
}

const signal = () => new AbortController().signal
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("with no World ID connected", () => {
  it("stand-in buttons approve and refuse", async () => {
    const desk = new ApprovalDesk({ links: memoryLinks() })
    const first = desk.approverFor("a")(REQUEST, signal())
    expect(desk.view("a")?.action).toBe("send_email")
    desk.answer("a", true)
    expect(await first).toBe("APPROVED")
    expect(desk.view("a")).toBeUndefined()
    const second = desk.approverFor("a")(REQUEST, signal())
    desk.answer("a", false)
    expect(await second).toBe("DENIED")
  })

  it("runs out of time", async () => {
    const desk = new ApprovalDesk({ links: memoryLinks(), approvalMs: 5 })
    expect(await desk.approverFor("a")(REQUEST, signal())).toBe("EXPIRED")
    expect(desk.view("a")).toBeUndefined()
  })

  it("will not start World ID", async () => {
    const desk = new ApprovalDesk({ links: memoryLinks() })
    void desk.approverFor("a")(REQUEST, signal())
    await expect(desk.startPass("a", "owner")).rejects.toThrow("not connected")
  })

  it("has nothing to answer when nothing waits", () => {
    expect(() => new ApprovalDesk({ links: memoryLinks() }).answer("a", true)).toThrow("nothing is waiting")
  })
})

describe("with World ID connected", () => {
  let pass: ReturnType<typeof fakePass>
  let desk: ApprovalDesk

  beforeEach(() => {
    pass = fakePass()
    desk = new ApprovalDesk({ pass, links: memoryLinks() })
  })

  it("a button on the page cannot approve, but can refuse", async () => {
    const waiting = desk.approverFor("a")(REQUEST, signal())
    expect(() => desk.answer("a", true)).toThrow("only be approved through World ID")
    expect(desk.view("a")).toBeDefined()
    desk.answer("a", false)
    expect(await waiting).toBe("DENIED")
    expect(pass.start).not.toHaveBeenCalled()
  })

  it("approves only after a validated person comes back", async () => {
    const waiting = desk.approverFor("a")(REQUEST, signal())
    const shown = await desk.startPass("a", "owner-a")
    expect(shown).toEqual({ userCode: "ABCD-EFGH", url: "https://auth.world.org/device?code=ABCD-EFGH" })
    expect(desk.view("a")?.pass).toEqual(shown)
    await flush()
    expect(desk.view("a")).toBeDefined()
    pass.finish(PERSON)
    expect(await waiting).toBe("APPROVED")
    expect(desk.note("a")).toContain("real person")
  })

  it("never shows the subject or anything secret", async () => {
    void desk.approverFor("a")(REQUEST, signal())
    await desk.startPass("a", "owner-a")
    const shown = JSON.stringify(desk.view("a"))
    expect(shown).not.toContain("person-1")
    expect(shown).not.toContain("cancel")
  })

  it("gives a person longer once they have started", async () => {
    const waiting = desk.approverFor("a")(REQUEST, signal())
    const before = desk.view("a")!.expiresAt
    await desk.startPass("a", "owner-a")
    expect(desk.view("a")!.expiresAt).toBeGreaterThan(before)
    desk.answer("a", false)
    await waiting
  })

  it("starts only one attempt for one call", async () => {
    const waiting = desk.approverFor("a")(REQUEST, signal())
    await desk.startPass("a", "owner-a")
    await desk.startPass("a", "owner-a")
    expect(pass.start).toHaveBeenCalledTimes(1)
    desk.answer("a", false)
    await waiting
  })

  it.each([
    ["denied", "DENIED"],
    ["expired", "EXPIRED"],
    ["invalid", "EXPIRED"],
    ["unavailable", "EXPIRED"],
  ] as const)("a %s result never approves", async (reason, expected) => {
    const waiting = desk.approverFor("a")(REQUEST, signal())
    await desk.startPass("a", "owner-a")
    pass.finish({ ok: false, reason, message: "No." })
    expect(await waiting).toBe(expected)
    expect(desk.note("a")).toContain("did not go ahead")
  })

  it("a STOP during the wait cancels the attempt and refuses the call", async () => {
    const abort = new AbortController()
    const waiting = desk.approverFor("a")(REQUEST, abort.signal)
    await desk.startPass("a", "owner-a")
    abort.abort()
    expect(await waiting).toBe("EXPIRED")
    expect(pass.cancel).toHaveBeenCalled()
  })

  it("a person who answers after the STOP changes nothing", async () => {
    const abort = new AbortController()
    const waiting = desk.approverFor("a")(REQUEST, abort.signal)
    await desk.startPass("a", "owner-a")
    abort.abort()
    pass.finish(PERSON)
    await flush()
    expect(await waiting).toBe("EXPIRED")
    expect(desk.note("a")).toBeUndefined()
  })

  it("cancels an attempt that started after the call stopped waiting", async () => {
    const abort = new AbortController()
    let release: (a: PassAttempt) => void = () => undefined
    const slow = fakePass()
    slow.start.mockImplementation(() => new Promise((r) => (release = r)))
    const slowDesk = new ApprovalDesk({ pass: slow, links: memoryLinks() })
    void slowDesk.approverFor("a")(REQUEST, abort.signal)
    const starting = slowDesk.startPass("a", "owner-a")
    abort.abort()
    release(slow.attempt)
    await expect(starting).rejects.toThrow("no longer waiting")
    expect(slow.cancel).toHaveBeenCalled()
  })

  it("links the first person to a company, and refuses anyone else after that", async () => {
    const links = memoryLinks()
    const first = fakePass()
    const one = new ApprovalDesk({ pass: first, links })
    let waiting = one.approverFor("a")(REQUEST, signal())
    await one.startPass("a", "owner-a")
    first.finish(PERSON)
    expect(await waiting).toBe("APPROVED")

    const second = fakePass()
    const two = new ApprovalDesk({ pass: second, links })
    waiting = two.approverFor("a")(REQUEST, signal())
    await two.startPass("a", "owner-a")
    second.finish({ ...PERSON, subject: "person-2" } as PassResult)
    expect(await waiting).toBe("DENIED")
    expect(two.note("a")).toContain("different person")

    const third = fakePass()
    const three = new ApprovalDesk({ pass: third, links })
    waiting = three.approverFor("a")(REQUEST, signal())
    await three.startPass("a", "owner-a")
    third.finish(PERSON)
    expect(await waiting).toBe("APPROVED")
  })

  it("keeps each company's approver separate", async () => {
    const links = memoryLinks()
    const a = fakePass()
    const deskA = new ApprovalDesk({ pass: a, links })
    const waitingA = deskA.approverFor("a")(REQUEST, signal())
    await deskA.startPass("a", "owner-a")
    a.finish(PERSON)
    expect(await waitingA).toBe("APPROVED")

    const b = fakePass()
    const deskB = new ApprovalDesk({ pass: b, links })
    const waitingB = deskB.approverFor("b")(REQUEST, signal())
    await deskB.startPass("b", "owner-b")
    b.finish({ ...PERSON, subject: "person-2" } as PassResult)
    expect(await waitingB).toBe("APPROVED")
  })
})
