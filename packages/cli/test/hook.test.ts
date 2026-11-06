import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { liftRecall, stopAgent, stopFleet, stopTool } from "../src/actions"
import { askHook } from "../src/hook"
import { type Config, initHome } from "../src/home"
import { ledgerFor } from "../src/ledger"
import { addStopHook, hasStopHook, hookCommand, removeStopHook } from "../src/protect"

const SELF = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\tools\\ceasenet\\ceasenet.mjs"] }

let dir: string
let previousHome: string | undefined
let config: Config
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ceasenet-hook-"))
  previousHome = process.env.CEASENET_HOME
  process.env.CEASENET_HOME = join(dir, "home")
  config = initHome({ name: "Test agent", network: "local", accessKey: "" }).config
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.CEASENET_HOME
  else process.env.CEASENET_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

describe("asking before one of Claude Code's own tools runs", () => {
  const ledger = () => ledgerFor(config)

  it("allows it while nothing is wrong", async () => {
    expect(await askHook()).toEqual({ kind: "allow" })
  })

  it("refuses it once this agent is stopped, and says why", async () => {
    await stopAgent(ledger(), config, config.agent.address, "It is deleting files")
    const answer = await askHook()
    expect(answer.kind).toBe("refuse")
    expect(answer.kind === "refuse" && answer.reason).toContain("It is deleting files")
  })

  it("refuses it once the whole fleet is stopped", async () => {
    await stopFleet(ledger(), config, "Something is very wrong")
    expect((await askHook()).kind).toBe("refuse")
  })

  it("sees a stop made a moment after it last allowed something", async () => {
    expect((await askHook()).kind).toBe("allow")
    await stopAgent(ledger(), config, config.agent.address, "just now")
    expect((await askHook()).kind).toBe("refuse")
  })

  it("is not stopped by another agent's stop, or by one tool's recall", async () => {
    await stopAgent(ledger(), config, "0x00000000000000000000000000000000000000ab", "someone else")
    await stopTool(ledger(), config, { name: "some-mcp-tool", reason: "only that tool" })
    expect((await askHook()).kind).toBe("allow")
  })

  it("ignores a stop from a key nobody follows", async () => {
    const stranger = ledger().writer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
    await stranger.stop({ artifact: `agent:${config.agent.address.toLowerCase()}`, severity: "CRITICAL", reason: "fake" })
    expect((await askHook()).kind).toBe("allow")
  })

  it("allows it again once the stop is lifted", async () => {
    const { entityKey } = await stopAgent(ledger(), config, config.agent.address, "for now")
    expect((await askHook()).kind).toBe("refuse")
    await liftRecall(ledger(), config, entityKey)
    expect((await askHook()).kind).toBe("allow")
  })

  it("does not read the list again for a burst of calls", async () => {
    const t = 1_000_000
    await askHook(t)
    rmSync(join(dir, "home", "config.json"))
    // With its settings gone a real check would have nothing to go on, so this answer came from the recent one.
    expect(await askHook(t + 500)).toEqual({ kind: "allow" })
  })

  it("leaves a machine alone once CeaseNet is removed from it", async () => {
    rmSync(join(dir, "home"), { recursive: true, force: true })
    expect(await askHook()).toEqual({ kind: "allow" })
  })
})

describe("the hook in Claude Code's settings", () => {
  const path = () => join(dir, "settings.json")
  const read = () => JSON.parse(readFileSync(path(), "utf8"))

  it("creates the settings if there are none", () => {
    expect(hasStopHook(path())).toBe(false)
    expect(addStopHook(SELF, path()).changed).toHaveLength(1)
    expect(hasStopHook(path())).toBe(true)
    expect(read().hooks.PreToolUse[0].matcher).toBe("*")
  })

  it("keeps every setting and hook that was already there, and a copy of the file", () => {
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "done.sh" }] }] },
    }
    writeFileSync(path(), JSON.stringify(original))
    const { backup } = addStopHook(SELF, path())
    const after = read()
    expect(after.model).toBe("opus")
    expect(after.permissions).toEqual(original.permissions)
    expect(after.hooks.Stop).toEqual(original.hooks.Stop)
    expect(after.hooks.PreToolUse).toHaveLength(2)
    expect(after.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0])
    expect(JSON.parse(readFileSync(backup!, "utf8"))).toEqual(original)
  })

  it("is not added twice", () => {
    addStopHook(SELF, path())
    const before = readFileSync(path(), "utf8")
    expect(addStopHook(SELF, path()).changed).toEqual([])
    expect(readFileSync(path(), "utf8")).toBe(before)
  })

  it("comes out cleanly, leaving other hooks where they were", () => {
    const original = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }] } }
    writeFileSync(path(), JSON.stringify(original))
    addStopHook(SELF, path())
    expect(removeStopHook(path()).changed).toHaveLength(1)
    expect(read()).toEqual(original)
    expect(hasStopHook(path())).toBe(false)
  })

  it("leaves no empty blocks behind when it was the only hook", () => {
    writeFileSync(path(), JSON.stringify({ model: "opus" }))
    addStopHook(SELF, path())
    removeStopHook(path())
    expect(read()).toEqual({ model: "opus" })
  })

  it("does not touch a file it cannot read as plain JSON", () => {
    writeFileSync(path(), "{ // not plain\n}")
    expect(addStopHook(SELF, path()).problem).toContain("left alone")
    expect(readFileSync(path(), "utf8")).toBe("{ // not plain\n}")
  })

  it("does nothing to remove when there is no file", () => {
    expect(removeStopHook(join(dir, "none.json")).changed).toEqual([])
    expect(existsSync(join(dir, "none.json"))).toBe(false)
  })

  it("quotes paths with spaces, in a form any shell can run", () => {
    expect(hookCommand(SELF)).toBe('"C:/Program Files/nodejs/node.exe" "C:/tools/ceasenet/ceasenet.mjs" hook')
  })
})
