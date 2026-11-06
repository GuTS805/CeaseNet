import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GateRunner, identityFiles, type LoadedFile, memoryStore, verdictFor } from "@ceasenet/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  currentPolicy,
  explainWriteError,
  isEnded,
  liftRecall,
  ownerWriter,
  publishIdentity,
  setFollowing,
  stopAgent,
  stopFleet,
  stopTool,
} from "../src/actions"
import { type GuardStatus, liveGuards, recordCall, recentCalls, writeStatus } from "../src/activity"
import { toolRows } from "../src/daemon"
import { type Config, initHome, loadHolds, loadKeys, obeyingOwner, saveConfig, setHold, startingPolicy } from "../src/home"
import { ledgerFor } from "../src/ledger"

let dir: string
let previousHome: string | undefined
let config: Config
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-actions-"))
  previousHome = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = dir
  config = initHome({ name: "Test agent", network: "local", accessKey: "" }).config
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

const TOOL: LoadedFile = { kind: "tool", name: "real-tool", version: "1.2.3", hash: "0xabc" }
const OTHER: LoadedFile = { kind: "tool", name: "other-tool", version: "1.0.0", hash: "0xdef" }

/** What a real gate on this machine would decide right now, from what is really on the list. */
async function decide(files: LoadedFile[] = [TOOL, OTHER]) {
  const net = ledgerFor(config).readOnlyNet()
  const runner = new GateRunner({ policy: startingPolicy(config.owner.address), timers: { graceMs: 1000, offlineSupervisedMs: 1000 }, store: memoryStore() })
  const all = [...files, ...identityFiles(config.agent.address, config.owner.address)]
  const result = await runner.check(all, (policy, remembered) => net.readView(policy, remembered))
  return Object.fromEntries(files.map((f) => [f.name, verdictFor(result.decision, f.hash)]))
}

describe("setting up", () => {
  it("makes a separate agent and owner", () => {
    expect(config.agent.address).not.toBe(config.owner.address)
    expect(loadKeys().owner).toBeDefined()
  })

  it("will not replace an identity that exists", () => {
    const again = initHome({ name: "Another", network: "arkiv", accessKey: "" })
    expect(again.created).toBe(false)
    expect(again.config.agent.address).toBe(config.agent.address)
    expect(again.config.network).toBe("local")
  })

  it("trusts nobody but the owner to begin with: no key of ours", () => {
    const policy = startingPolicy(config.owner.address)
    expect(policy.issuers).toEqual([config.owner.address])
    expect(policy.regulators).toEqual([])
  })
})

describe("stopping things", () => {
  const ledger = () => ledgerFor(config)

  it("stops one exact file, and leaves other tools alone", async () => {
    expect(await decide()).toEqual({ "real-tool": "ALLOW", "other-tool": "ALLOW" })
    await stopTool(ledger(), config, { hash: TOOL.hash, reason: "copies mail" })
    expect(await decide()).toEqual({ "real-tool": "BLOCK", "other-tool": "ALLOW" })
  })

  it("stops a tool by name, whatever version it is", async () => {
    await stopTool(ledger(), config, { name: "real-tool", reason: "copies mail" })
    expect(await decide()).toEqual({ "real-tool": "BLOCK", "other-tool": "ALLOW" })
  })

  it("stops only the versions a range covers", async () => {
    await stopTool(ledger(), config, { name: "real-tool", versions: "<1.0.0", reason: "old" })
    expect(await decide()).toEqual({ "real-tool": "ALLOW", "other-tool": "ALLOW" })
    await stopTool(ledger(), config, { name: "real-tool", versions: ">=1.2.0 <1.3.0", reason: "bad" })
    expect(await decide()).toEqual({ "real-tool": "BLOCK", "other-tool": "ALLOW" })
  })

  it("stops this agent's every tool", async () => {
    await stopAgent(ledger(), config, config.agent.address, "misbehaving")
    expect(await decide()).toEqual({ "real-tool": "BLOCK", "other-tool": "BLOCK" })
  })

  it("does not stop this agent when another one is named", async () => {
    await stopAgent(ledger(), config, "0x00000000000000000000000000000000000000ab", "misbehaving")
    expect(await decide()).toEqual({ "real-tool": "ALLOW", "other-tool": "ALLOW" })
  })

  it("stops every agent this owner has", async () => {
    await stopFleet(ledger(), config, "something is very wrong")
    expect(await decide()).toEqual({ "real-tool": "BLOCK", "other-tool": "BLOCK" })
  })

  it("starts again when lifted", async () => {
    const { entityKey } = await stopAgent(ledger(), config, config.agent.address, "misbehaving")
    await liftRecall(ledger(), config, entityKey, "sorted")
    expect(await decide()).toEqual({ "real-tool": "ALLOW", "other-tool": "ALLOW" })
  })

  it("needs a reason, because the agent is told it", () => {
    expect(() => stopTool(ledger(), config, { hash: "0x1", reason: "  " })).toThrow(/reason/)
    expect(() => stopAgent(ledger(), config, config.agent.address, "")).toThrow(/reason/)
    expect(() => stopFleet(ledger(), config, "")).toThrow(/reason/)
  })

  it("needs to know what to stop", () => {
    expect(() => stopTool(ledger(), config, { reason: "why" })).toThrow(/which tool/)
  })

  it("will not lift a recall this owner did not issue", async () => {
    await expect(liftRecall(ledger(), config, "0x1234", "mine now")).rejects.toThrow(/did not issue/)
  })

  it("marks a lifted recall as ended", async () => {
    const { entityKey } = await stopTool(ledger(), config, { hash: TOOL.hash, reason: "x" })
    await liftRecall(ledger(), config, entityKey)
    const { rows } = await ledger().recalls([config.owner.address])
    const lifts = await ledger().lifts(rows.map((r) => r.key))
    expect(isEnded(rows[0]!, lifts, startingPolicy(config.owner.address))).toBe(true)
  })
})

describe("whom an owner obeys", () => {
  const OUTSIDER = "0x00000000000000000000000000000000000000dd"
  const ledger = () => ledgerFor(config)

  it("ignores a STOP from anyone else, even one aimed straight at this agent", async () => {
    const stranger = ledger().writer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    await stranger.stop({ artifact: `agent:${config.agent.address.toLowerCase()}`, severity: "CRITICAL", reason: "fake" })
    await stranger.stop({ artifact: TOOL.hash, severity: "CRITICAL", reason: "fake" })
    expect(await decide()).toEqual({ "real-tool": "ALLOW", "other-tool": "ALLOW" })
  })

  it("obeys someone after following them, and not after unfollowing", async () => {
    const maker = ledger().writer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    await maker.stop({ artifact: TOOL.hash, severity: "HIGH", reason: "the maker says so" })
    expect((await decide())["real-tool"]).toBe("ALLOW")

    await setFollowing(ledger(), config, maker.address, true)
    expect((await decide())["real-tool"]).toBe("BLOCK")

    await setFollowing(ledger(), config, maker.address, false)
    expect((await decide())["real-tool"]).toBe("ALLOW")
  })

  it("cannot stop obeying itself", async () => {
    await expect(setFollowing(ledger(), config, config.owner.address, false)).rejects.toThrow(/always obey/)
  })

  it("still obeys itself even if a published list leaves it out", () => {
    const owner = config.owner.address
    expect(obeyingOwner({ ...startingPolicy(owner), issuers: [OUTSIDER] }, owner).issuers).toContain(owner)
  })

  it("refuses something that is not an address", async () => {
    await expect(setFollowing(ledger(), config, "not-an-address", true)).rejects.toThrow(/not an address/)
  })

  it("publishes its list and registers the agent once, however often it is asked", async () => {
    expect(await publishIdentity(ledger(), config)).toHaveLength(2)
    expect(await publishIdentity(ledger(), config)).toEqual([])
    expect((await ledger().agents(config.owner.address)).map((a) => a.agent)).toEqual([config.agent.address])
    expect((await currentPolicy(ledger(), config)).issuers).toEqual([config.owner.address])
  })
})

describe("an owner whose key is on another machine", () => {
  it("cannot be spoken for from here, and says so", () => {
    rmSync(join(dir, "config.json"))
    rmSync(join(dir, "keys.json"))
    const remote = initHome({ name: "Server agent", network: "local", accessKey: "", owner: "0x00000000000000000000000000000000000000ee" }).config
    expect(loadKeys().owner).toBeUndefined()
    expect(() => ownerWriter(ledgerFor(remote), remote)).toThrow(/not on this machine/)
    expect(() => stopAgent(ledgerFor(remote), remote, remote.agent.address, "x")).toThrow(/not on this machine/)
  })

  it("is obeyed here when it stops this agent from there", async () => {
    // Two machines, one list: the owner's home and the agent's home share a list file, as they would share Arkiv.
    const ledgerFile = join(dir, "shared.jsonl")
    saveConfig({ ...config, ledgerFile })
    config = { ...config, ledgerFile }
    const ownerSide = config
    const agentAddress = "0x00000000000000000000000000000000000000ab"
    const agentSide: Config = { ...config, agent: { name: "Server agent", address: agentAddress } }

    await stopAgent(ledgerFor(ownerSide), ownerSide, agentAddress, "from my laptop")

    const net = ledgerFor(agentSide).readOnlyNet()
    const runner = new GateRunner({ policy: startingPolicy(ownerSide.owner.address), timers: { graceMs: 1000, offlineSupervisedMs: 1000 }, store: memoryStore() })
    const result = await runner.check([TOOL, ...identityFiles(agentAddress, ownerSide.owner.address)], (p, r) => net.readView(p, r))
    expect(verdictFor(result.decision, TOOL.hash)).toBe("BLOCK")
  })
})

describe("explaining a failed write", () => {
  it("tells the owner what to do about having no funds", () => {
    const e = explainWriteError(new Error("insufficient funds for gas * price + value: address 0x1"), "0xabc")
    expect(e.message).toContain("0xabc")
    expect(e.message).toContain("faucet")
  })

  it("keeps only the first line of anything else", () => {
    expect(explainWriteError(new Error("short\nand then pages of it"), "0xabc").message).toBe("short")
  })
})

describe("holds", () => {
  it("are remembered, and can be released", () => {
    expect(loadHolds()).toEqual([])
    setHold("a", true)
    setHold("b", true)
    setHold("a", false)
    expect(loadHolds()).toEqual(["b"])
  })
})

describe("the record of calls", () => {
  const call = (over: object = {}) => ({ at: 1, server: "s", tool: "t", version: "1", action: "a", allowed: true, verdict: "ALLOW", message: "", gateMs: 1, ...over })

  it("comes back newest first", () => {
    recordCall(call({ at: 1 }))
    recordCall(call({ at: 2 }))
    expect(recentCalls().map((c) => c.at)).toEqual([2, 1])
  })

  it("is limited to what was asked for", () => {
    for (let i = 0; i < 5; i++) recordCall(call({ at: i }))
    expect(recentCalls(2).map((c) => c.at)).toEqual([4, 3])
  })
})

describe("what guards report", () => {
  const status = (over: Partial<GuardStatus> = {}): GuardStatus => ({
    pid: process.pid,
    server: "files",
    file: TOOL,
    strength: "pinned",
    online: true,
    mode: "ALLOW",
    startedAt: 1,
    updatedAt: 1,
    ...over,
  })

  it("forgets a guard that has died", () => {
    writeStatus(status())
    writeStatus(status({ pid: 999_999_999, server: "gone" }))
    expect(liveGuards().map((g) => g.server)).toEqual(["files"])
  })

  it("shows one row for a tool used by two clients, in its strictest state", () => {
    const rows = toolRows([status({ toolPid: 11 }), status({ pid: 2, server: "files-2", mode: "BLOCK" })], [], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ mode: "BLOCK", guards: 2, toolPids: [11], servers: ["files", "files-2"] })
  })

  it("counts calls and refusals for each tool", () => {
    const calls = [
      { at: 5, server: "s", tool: "real-tool", version: "1.2.3", action: "a", allowed: false, verdict: "BLOCK", message: "no", gateMs: 1 },
      { at: 4, server: "s", tool: "real-tool", version: "1.2.3", action: "a", allowed: true, verdict: "ALLOW", message: "", gateMs: 1 },
      { at: 3, server: "s", tool: "other", version: "1", action: "a", allowed: true, verdict: "ALLOW", message: "", gateMs: 1 },
    ]
    expect(toolRows([status()], calls, ["real-tool"])[0]).toMatchObject({ calls: 2, refused: 1, lastCallAt: 5, held: true })
  })
})
