import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { type GateView, type LoadedFile, memoryStore, type RecallRow, type TrustPolicy } from "@ceasenet/core"
import { afterEach, describe, expect, it } from "vitest"
import { Guard, type GuardNet } from "../src/guard"
import { measureDir, measurePackage } from "../src/measure"
import { GuardedTool } from "../src/mcp"
import { runProxy } from "../src/proxyCore"

const ROOT = join(__dirname, "..", "..", "..")
const TOOL = join(ROOT, "tools", "demo-mail-tool-1.0.16")
const MAKER = "0x00000000000000000000000000000000000000aa" as const
const policy: TrustPolicy = { issuers: [MAKER], regulators: [], verifier: "0x00000000000000000000000000000000000000cc", threshold: 3 }

class FakeNet implements GuardNet {
  view: Partial<GateView> = {}
  async readView(): Promise<GateView> {
    return { block: 10n, stops: [], advisories: [], endorsements: [], lifts: [], ...this.view }
  }
  async writeLoadout() {}
  async writeHeartbeat() {}
  async writeAck() {}
  async extendRecall() {}
}

const temp: string[] = []
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "ceasenet-"))
  temp.push(dir)
  return dir
}
afterEach(() => {
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const stopFor = (file: LoadedFile): RecallRow => ({
  key: "0x01",
  artifact: file.hash,
  level: "STOP",
  severity: "HIGH",
  reason: "copies mail",
  contentHash: "0xc",
  creator: MAKER,
  createdAt: 5n,
  expiresAt: 7_000_000n,
})

function guardFor(file: LoadedFile, approve?: any) {
  const net = new FakeNet()
  let t = 0
  const guard = new Guard({
    policy,
    timers: { checkIntervalMs: 100, heartbeatIntervalMs: 100, heartbeatTtlSeconds: 10, graceMs: 1000, offlineSupervisedMs: 1000 },
    store: memoryStore(),
    files: [file],
    net,
    startSeq: 1n,
    approve,
    now: () => (t += 2000),
  })
  return { guard, net }
}

const env = (dir: string) => ({ DEMO_SANDBOX: dir, DEMO_COMPANY: "Test", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" })
const email = { to: "a@example.com", subject: "s", body: "b" }

describe("measuring a package", () => {
  it("reads the name and version from the package itself", () => {
    expect(measurePackage(TOOL)).toMatchObject({ kind: "tool", name: "demo-mail-tool", version: "1.0.16" })
  })

  it("gives different hashes to the bad version and the fix", () => {
    expect(measureDir(TOOL)).not.toBe(measureDir(join(ROOT, "tools", "demo-mail-tool-1.0.17")))
  })

  it("changes when one byte of a file changes, whatever the package claims", () => {
    const dir = sandbox()
    writeFileSync(join(dir, "package.json"), '{"name":"x","version":"1.0.0"}')
    writeFileSync(join(dir, "a.js"), "one")
    const before = measureDir(dir)
    writeFileSync(join(dir, "a.js"), "two")
    expect(measureDir(dir)).not.toBe(before)
  })

  it("counts a renamed file as a change", () => {
    const dir = sandbox()
    writeFileSync(join(dir, "a.js"), "one")
    const before = measureDir(dir)
    rmSync(join(dir, "a.js"))
    writeFileSync(join(dir, "b.js"), "one")
    expect(measureDir(dir)).not.toBe(before)
  })

  it("ignores installed dependencies", () => {
    const dir = sandbox()
    writeFileSync(join(dir, "a.js"), "one")
    const before = measureDir(dir)
    mkdirSync(join(dir, "node_modules"))
    writeFileSync(join(dir, "node_modules", "x.js"), "other")
    expect(measureDir(dir)).toBe(before)
  })

  it("refuses a package with no name or version", () => {
    const dir = sandbox()
    writeFileSync(join(dir, "package.json"), "{}")
    expect(() => measurePackage(dir)).toThrow(/no name and version/)
  })
})

describe("a real MCP tool behind the guard", () => {
  const file = measurePackage(TOOL)
  const process_ = (dir: string) => ({ command: process.execPath, args: [join(TOOL, "server.mjs")], cwd: ROOT, env: env(dir) })

  it("lists the tool's real functions", async () => {
    const dir = sandbox()
    const { guard } = guardFor(file)
    const tool = await GuardedTool.connect(guard, file, process_(dir))
    expect(tool.specs.map((s) => s.name)).toEqual(["send_email"])
    await tool.close()
  })

  it("lets a clean call through, and the bad version really does leak", async () => {
    const dir = sandbox()
    const { guard } = guardFor(file)
    await guard.start()
    const tool = await GuardedTool.connect(guard, file, process_(dir))
    const result = await tool.call("send_email", email)
    await tool.close()
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "attacker-inbox.jsonl"), "utf8")).toContain("a@example.com")
  })

  it("never reaches the tool once it is recalled: nothing is sent and nothing leaks", async () => {
    const dir = sandbox()
    const { guard, net } = guardFor(file)
    await guard.start()
    net.view = { stops: [stopFor(file)] }
    const tool = await GuardedTool.connect(guard, file, process_(dir))
    const result = await tool.call("send_email", email)
    await tool.close()
    expect(result.ok).toBe(false)
    expect(result.text).toContain("copies mail")
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    expect(existsSync(join(dir, "attacker-inbox.jsonl"))).toBe(false)
  })

  it("gives the tool no secrets from the agent's environment", async () => {
    const dir = sandbox()
    expect(Object.keys(process_(dir).env).sort()).toEqual(["DEMO_COMPANY", "DEMO_SANDBOX", "PATH", "SystemRoot"])
  })
})

describe("the proxy, in front of a real MCP server", () => {
  const file = measurePackage(TOOL)

  function start(dir: string, extra: Record<string, any> = {}) {
    const { approve, ...proxyOptions } = extra
    const { guard, net } = guardFor(file, approve)
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: any[] = []
    let waiting: ((v: void) => void) | undefined
    output.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l))
      waiting?.()
    })
    const proxy = runProxy({ guard, file, command: process.execPath, args: [join(TOOL, "server.mjs")], env: env(dir), input, output, ...proxyOptions })
    const send = (m: unknown) => input.write(`${JSON.stringify(m)}\n`)
    const reply = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const hit = lines.find((l) => l.id === id)
        if (hit) return hit
        await Promise.race([new Promise((r) => (waiting = r)), new Promise((r) => setTimeout(r, 25))])
      }
      throw new Error(`no reply to ${id}`)
    }
    const initialize = async () => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
      await reply(1)
      send({ jsonrpc: "2.0", method: "notifications/initialized" })
    }
    const call = (id: number) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_email", arguments: email } })
    const stop = () => {
      proxy.kill()
    }
    return { guard, net, proxy, lines, send, reply, initialize, call, stop }
  }

  it("passes the protocol through and forwards an allowed call", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect((await p.reply(2)).result.tools[0].name).toBe("send_email")
    p.call(3)
    expect((await p.reply(3)).result.isError).toBeFalsy()
    expect(existsSync(join(dir, "attacker-inbox.jsonl"))).toBe(true)
    p.stop()
  })

  it("answers a refused call itself, so the tool never sees it", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    p.net.view = { stops: [stopFor(file)] }
    p.call(2)
    const answer = await p.reply(2)
    expect(answer.result.isError).toBe(true)
    expect(answer.result.content[0].text).toContain("copies mail")
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    p.stop()
  })

  it("still answers other requests after refusing a call, from what the tool said before it was ended", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await p.reply(2)
    p.net.view = { stops: [stopFor(file)] }
    p.call(3)
    p.send({ jsonrpc: "2.0", id: 4, method: "tools/list" })
    expect((await p.reply(3)).result.isError).toBe(true)
    expect((await p.reply(4)).result.tools).toHaveLength(1)
    p.stop()
  })

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (test: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it("ends the tool's process when a STOP arrives, not just its calls", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    const pid = p.proxy.pid!
    expect(isAlive(pid)).toBe(true)
    p.net.view = { stops: [stopFor(file)] }
    await p.guard.check(true)
    expect(p.proxy.pid).toBeUndefined()
    await until(() => !isAlive(pid), "the tool to end")
    p.stop()
  })

  it("never starts a tool that is already under a STOP, and still answers the agent", async () => {
    const dir = sandbox()
    const p = start(dir)
    p.net.view = { stops: [stopFor(file)] }
    await p.guard.start()
    expect(p.proxy.pid).toBeUndefined()
    await p.initialize()
    expect(p.lines.find((l) => l.id === 1).result.instructions).toContain("copies mail")
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect((await p.reply(2)).result.tools).toEqual([])
    p.call(3)
    expect((await p.reply(3)).result.content[0].text).toContain("copies mail")
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    p.stop()
  })

  it("starts the tool again when the STOP is lifted, without the agent having to reconnect", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    const stop = stopFor(file)
    p.net.view = { stops: [stop] }
    await p.guard.check(true)
    expect(p.proxy.pid).toBeUndefined()

    p.net.view = { stops: [stop], lifts: [{ key: "0x02", recall: stop.key, artifact: stop.artifact, kind: "WITHDRAWN", creator: MAKER, createdAt: 6n }] }
    await p.guard.check(true)
    expect(p.proxy.pid).toBeDefined()
    p.call(2)
    expect((await p.reply(2)).result.isError).toBeFalsy()
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(true)
    p.stop()
  })

  it("tells an agent that started during a STOP to look again once it is lifted", async () => {
    const dir = sandbox()
    const p = start(dir)
    const stop = stopFor(file)
    p.net.view = { stops: [stop] }
    await p.guard.start()
    await p.initialize()
    p.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await p.reply(2)

    p.net.view = { stops: [stop], lifts: [{ key: "0x02", recall: stop.key, artifact: stop.artifact, kind: "WITHDRAWN", creator: MAKER, createdAt: 6n }] }
    await p.guard.check(true)
    await until(() => p.lines.some((l) => l.method === "notifications/tools/list_changed"), "the list to change")
    p.send({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    expect((await p.reply(3)).result.tools[0].name).toBe("send_email")
    p.stop()
  })

  it("does not let a call through inside a batch", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    p.net.view = { stops: [stopFor(file)] }
    p.send([{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_email", arguments: email } }])
    expect((await p.reply(2)).result.isError).toBe(true)
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    p.stop()
  })

  it("gates reading a resource and getting a prompt, not only tool calls", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    p.net.view = { stops: [stopFor(file)] }
    p.send({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "file:///secret" } })
    p.send({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "x" } })
    expect((await p.reply(2)).error.message).toContain("copies mail")
    expect((await p.reply(3)).error.message).toContain("copies mail")
    p.stop()
  })

  it("refuses a request the tool never got an answer to, when a STOP ends it mid-call", async () => {
    const dir = sandbox()
    const p = start(dir)
    await p.guard.start()
    await p.initialize()
    // Asked of the tool, then the tool is ended before anything reads its reply.
    p.send({ jsonrpc: "2.0", id: 2, method: "not/a/real/method" })
    p.net.view = { stops: [stopFor(file)] }
    await p.guard.check(true)
    const answer = await p.reply(2)
    expect(answer.error ?? answer.result).toBeDefined()
    p.stop()
  })

  it("does not reach a tool the owner has blocked on this machine, whatever the list says", async () => {
    const dir = sandbox()
    let blocked: string | undefined
    const p = start(dir, { localBlock: () => blocked })
    await p.guard.start()
    await p.initialize()
    const pid = p.proxy.pid!
    blocked = "its files changed after they were measured"
    p.call(2)
    expect((await p.reply(2)).result.content[0].text).toContain("its files changed")
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    await until(() => !isAlive(pid), "the tool to end")
    p.stop()
  })

  it("asks a person when the owner has asked to approve each call", async () => {
    const dir = sandbox()
    let answer: "APPROVED" | "DENIED" = "DENIED"
    const asked: string[] = []
    const p = start(dir, {
      holdReason: () => "The owner approves each call to this tool.",
      approve: async (request: { action: string; details?: string }) => {
        asked.push(`${request.action} ${request.details}`)
        return answer
      },
    })
    await p.guard.start()
    await p.initialize()
    p.call(2)
    expect((await p.reply(2)).result.isError).toBe(true)
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(false)
    expect(asked[0]).toContain("send_email")
    expect(asked[0]).toContain("a@example.com")

    answer = "APPROVED"
    p.call(3)
    expect((await p.reply(3)).result.isError).toBeFalsy()
    expect(existsSync(join(dir, "sent.jsonl"))).toBe(true)
    p.stop()
  })

  it("says what each call came back with once it is over, and what each refusal said", async () => {
    const dir = sandbox()
    const finished: any[] = []
    const p = start(dir, { onFinished: (c: any) => finished.push(c) })
    await p.guard.start()
    await p.initialize()
    p.call(2)
    await p.reply(2)
    p.net.view = { stops: [stopFor(file)] }
    p.call(3)
    await p.reply(3)
    expect(finished).toHaveLength(2)
    expect(finished[0]).toMatchObject({ action: "send_email", args: email })
    expect(JSON.stringify(finished[0].result)).toContain("Email sent")
    expect(finished[1].decision.allowed).toBe(false)
    expect(finished[1].result).toBeUndefined()
    p.stop()
  })

  it("reports every call and what the gate decided", async () => {
    const dir = sandbox()
    const calls: { action: string; allowed: boolean }[] = []
    const p = start(dir, { onCall: (c: { action: string; decision: { allowed: boolean } }) => calls.push({ action: c.action, allowed: c.decision.allowed }) })
    await p.guard.start()
    await p.initialize()
    p.call(2)
    await p.reply(2)
    p.net.view = { stops: [stopFor(file)] }
    p.call(3)
    await p.reply(3)
    expect(calls).toEqual([
      { action: "send_email", allowed: true },
      { action: "send_email", allowed: false },
    ])
    p.stop()
  })
})
